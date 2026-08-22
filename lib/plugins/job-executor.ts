/**
 * Provider-neutral host executor for generic plugin jobs.
 *
 * This module only executes statically registered job IDs. It deliberately
 * does not load code, endpoints, or method names from a job document. The Pan
 * scheduler still owns its legacy collection until an explicit projection
 * migration switches that source of truth to PluginJobRunner.
 */

import { randomUUID } from "node:crypto";
import {
  PluginJobError,
  PluginJobRunner,
  InMemoryPluginJobStore,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobErrorSnapshot,
  type PluginJobFinishInput,
  type PluginJobLeaseCredential,
  type PluginJobProgressPatch,
  type PluginJobRun,
  type PluginJobRunnerPort,
  type PluginJobStatus,
  type PluginJobTerminalStatus,
  normalizePluginJobId,
} from "@/lib/plugins/job-runner";

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 2 * 1000;
const MIN_TIMER_MS = 1;
const MAX_TIMER_MS = 10 * 60 * 1000;

export interface PluginJobExecutionContext {
  readonly run: PluginJobRun;
  readonly credential: PluginJobLeaseCredential;
  readonly signal: AbortSignal;
  reportProgress(patch: PluginJobProgressPatch): Promise<PluginJobRun>;
  setCursor(cursor?: string): Promise<PluginJobRun>;
  isCancellationRequested(): Promise<boolean>;
}

export interface PluginJobHandlerResult {
  readonly status?: PluginJobTerminalStatus;
  readonly error?: PluginJobErrorSnapshot;
}

export type PluginJobHandler = (
  context: PluginJobExecutionContext
) => Promise<PluginJobHandlerResult | void>;

export interface PluginJobHandlerRegistration {
  /** Stable, host-owned job ID. Never read a handler name from job metadata. */
  readonly jobId: string;
  /** The registration is bound to one plugin identity. */
  readonly pluginId: string;
  /** When present, only this exact plugin version may execute the job. */
  readonly pluginVersion?: string;
  readonly execute: PluginJobHandler;
}

export interface PluginHostExecutorOptions {
  readonly owner?: string;
  readonly leaseTtlMs?: number;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly cancellationPollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface PluginHostExecutorDependencies {
  readonly runner: PluginJobRunnerPort;
  readonly handlers: ReadonlyMap<string, PluginJobHandlerRegistration>;
}

function assertTimer(value: number | undefined, field: string, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < MIN_TIMER_MS || candidate > MAX_TIMER_MS) {
    throw new RangeError(`${field} 必须是 ${MIN_TIMER_MS} 到 ${MAX_TIMER_MS} 的整数`);
  }
  return candidate;
}

function assertLeaseTtl(value: number | undefined): number {
  const candidate = value ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(candidate) || candidate < 100 || candidate > MAX_TIMER_MS) {
    throw new RangeError(`leaseTtlMs 必须是 100 到 ${MAX_TIMER_MS} 的整数`);
  }
  return candidate;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} 不能为空`);
  }
  return value.trim();
}

function normalizeRegistration(
  registration: PluginJobHandlerRegistration
): PluginJobHandlerRegistration {
  return {
    jobId: normalizePluginJobId(registration.jobId),
    pluginId: nonEmpty(registration.pluginId, "pluginId"),
    ...(registration.pluginVersion
      ? { pluginVersion: nonEmpty(registration.pluginVersion, "pluginVersion") }
      : {}),
    execute: registration.execute,
  };
}

/** Build an immutable-by-convention static registry and reject duplicates. */
export function createPluginJobHandlerRegistry(
  registrations: readonly PluginJobHandlerRegistration[]
): ReadonlyMap<string, PluginJobHandlerRegistration> {
  const registry = new Map<string, PluginJobHandlerRegistration>();
  for (const item of registrations) {
    const registration = normalizeRegistration(item);
    if (typeof registration.execute !== "function") {
      throw new TypeError(`job ${registration.jobId} 缺少执行函数`);
    }
    if (registry.has(registration.jobId)) {
      throw new TypeError(`重复注册宿主任务：${registration.jobId}`);
    }
    registry.set(registration.jobId, Object.freeze(registration));
  }
  return registry;
}

function errorSnapshot(error: unknown): PluginJobErrorSnapshot {
  if (error instanceof PluginJobError) {
    return {
      code: error.code,
      message: error.message.slice(0, 1500),
      retryable: false,
    };
  }
  return {
    code: "HOST_EXECUTOR_ERROR",
    message: (error instanceof Error ? error.message : String(error || "宿主任务执行失败")).slice(0, 1500),
    retryable: false,
  };
}

function waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function terminal(status: PluginJobStatus): status is PluginJobTerminalStatus {
  return status === "succeeded" || status === "partial" || status === "failed" || status === "cancelled";
}

/**
 * A single-process host worker. Multiple instances are safe because claimNext
 * is atomic and every mutation is fenced by the runner's lease credential.
 */
export class PluginHostExecutor {
  private readonly owner: string;
  private readonly leaseTtlMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly cancellationPollIntervalMs: number;
  private readonly runner: PluginJobRunnerPort;
  private readonly handlers: ReadonlyMap<string, PluginJobHandlerRegistration>;
  private readonly controller = new AbortController();
  private readonly externalSignal?: AbortSignal;

  constructor(
    dependencies: PluginHostExecutorDependencies,
    options: PluginHostExecutorOptions = {}
  ) {
    this.runner = dependencies.runner;
    this.handlers = dependencies.handlers;
    this.owner = nonEmpty(options.owner || `plugin-host-${randomUUID()}`, "owner");
    this.leaseTtlMs = assertLeaseTtl(options.leaseTtlMs);
    this.pollIntervalMs = assertTimer(options.pollIntervalMs, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS);
    this.heartbeatIntervalMs = Math.min(
      assertTimer(
        options.heartbeatIntervalMs,
        "heartbeatIntervalMs",
        Math.max(100, Math.floor(this.leaseTtlMs / 3))
      ),
      Math.max(100, Math.floor(this.leaseTtlMs / 2))
    );
    this.cancellationPollIntervalMs = assertTimer(
      options.cancellationPollIntervalMs,
      "cancellationPollIntervalMs",
      DEFAULT_CANCELLATION_POLL_INTERVAL_MS
    );
    this.externalSignal = options.signal;
    if (options.signal) {
      if (options.signal.aborted) this.controller.abort(options.signal.reason);
      else options.signal.addEventListener("abort", () => this.stop(), { once: true });
    }
  }

  /** Stop future claims and request cooperative cancellation of the current handler. */
  stop(reason = "宿主执行器已停止"): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  /** Claim and execute at most one generic host job. */
  async runOnce(): Promise<PluginJobRun | null> {
    if (this.controller.signal.aborted || this.externalSignal?.aborted) return null;
    const claimed = await this.runner.claimNext({
      owner: this.owner,
      leaseTtlMs: this.leaseTtlMs,
      jobIds: [...this.handlers.keys()],
    });
    if (!claimed) return null;
    return this.executeClaimed(claimed);
  }

  /** Run until stop() or the supplied external signal is aborted. */
  async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const result = await this.runOnce();
      if (result || this.controller.signal.aborted) continue;
      await waitFor(this.pollIntervalMs, this.controller.signal);
    }
  }

  private async executeClaimed(claimed: PluginJobRun): Promise<PluginJobRun> {
    const registration = this.handlers.get(claimed.job_id);
    if (
      !registration ||
      registration.pluginId !== claimed.plugin_id ||
      (registration.pluginVersion !== undefined &&
        registration.pluginVersion !== claimed.plugin_version)
    ) {
      return this.finishWithoutHandler(claimed);
    }

    if (!claimed.lease) return claimed;
    const credential: PluginJobLeaseCredential = {
      owner: claimed.lease.owner,
      token: claimed.lease.token,
      fence: claimed.lease.fence,
    };
    const abortController = new AbortController();
    let shutdownRequested = this.controller.signal.aborted;
    const stopFromExecutor = () => {
      shutdownRequested = true;
      if (!abortController.signal.aborted) abortController.abort(this.controller.signal.reason);
    };
    if (this.controller.signal.aborted) stopFromExecutor();
    else this.controller.signal.addEventListener("abort", stopFromExecutor, { once: true });

    let current = claimed;
    let leaseLost = false;
    let cancellationRequested = false;
    let operationTail: Promise<void> = Promise.resolve();

    const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
      const next = operationTail.then(operation);
      operationTail = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    };

    const markLeaseLost = (reason: unknown) => {
      if (leaseLost) return;
      leaseLost = true;
      if (!abortController.signal.aborted) abortController.abort(reason);
    };

    const heartbeat = setInterval(() => {
      if (leaseLost || shutdownRequested || abortController.signal.aborted) return;
      void enqueueMutation(async () => {
        if (leaseLost || shutdownRequested) return;
        try {
          current = await this.runner.heartbeat(
            current.run_id,
            credential,
            this.leaseTtlMs
          );
        } catch (error) {
          markLeaseLost(error);
        }
      });
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();

    const cancellationPoll = setInterval(() => {
      if (leaseLost || shutdownRequested || cancellationRequested) return;
      void this.runner
        .isCancellationRequested(current.run_id)
        .then((requested) => {
          if (!requested) return;
          cancellationRequested = true;
          if (!abortController.signal.aborted) {
            abortController.abort("任务已请求取消");
          }
        })
        .catch(markLeaseLost);
    }, this.cancellationPollIntervalMs);
    cancellationPoll.unref?.();

    const context: PluginJobExecutionContext = {
      get run() {
        return current;
      },
      credential,
      signal: abortController.signal,
      reportProgress: (patch) =>
        enqueueMutation(async () => {
          if (leaseLost || shutdownRequested) {
            throw new PluginJobError(
              PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED,
              "任务租约已失效，不能继续报告进度"
            );
          }
          current = await this.runner.reportProgress(current.run_id, credential, patch);
          return current;
        }),
      setCursor: (cursor) =>
        enqueueMutation(async () => {
          if (leaseLost || shutdownRequested) {
            throw new PluginJobError(
              PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED,
              "任务租约已失效，不能继续更新游标"
            );
          }
          current = await this.runner.setCursor(current.run_id, credential, cursor);
          return current;
        }),
      isCancellationRequested: async () => {
        const requested = await this.runner.isCancellationRequested(current.run_id);
        if (requested) {
          cancellationRequested = true;
          if (!abortController.signal.aborted) abortController.abort("任务已请求取消");
        }
        return requested;
      },
    };

    let result: PluginJobHandlerResult | void = undefined;
    try {
      result = await registration.execute(context);
      await operationTail;
    } catch (error) {
      if (!leaseLost && !shutdownRequested && !cancellationRequested) {
        result = { status: "failed", error: errorSnapshot(error) };
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancellationPoll);
      this.controller.signal.removeEventListener("abort", stopFromExecutor);
    }

    if (leaseLost || shutdownRequested) return current;
    if (cancellationRequested || abortController.signal.aborted) {
      return this.finishClaimed(current, credential, { status: "cancelled" });
    }
    const status = result?.status || "succeeded";
    if (!terminal(status)) {
      return this.finishClaimed(current, credential, { status: "failed", error: errorSnapshot(new Error("宿主任务返回了无效终态")) });
    }
    return this.finishClaimed(current, credential, {
      status,
      ...(result?.error ? { error: result.error } : {}),
    });
  }

  private async finishWithoutHandler(run: PluginJobRun): Promise<PluginJobRun> {
    if (!run.lease) return run;
    return this.finishClaimed(run, {
      owner: run.lease.owner,
      token: run.lease.token,
      fence: run.lease.fence,
    }, {
      status: "failed",
      error: {
        code: "JOB_HANDLER_NOT_REGISTERED",
        message: `没有注册任务处理器：${run.job_id}`,
        retryable: false,
      },
    });
  }

  private async finishClaimed(
    run: PluginJobRun,
    credential: PluginJobLeaseCredential,
    input: PluginJobFinishInput
  ): Promise<PluginJobRun> {
    try {
      return await this.runner.finish(run.run_id, credential, input);
    } catch (error) {
      if (error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED) {
        return run;
      }
      throw error;
    }
  }
}

/** Convenience factory for callers that already own a generic runner. */
export function createPluginHostExecutor(
  dependencies: PluginHostExecutorDependencies,
  options?: PluginHostExecutorOptions
): PluginHostExecutor {
  return new PluginHostExecutor(dependencies, options);
}

/** Default in-memory runner helper for local tests and small one-process tools. */
export function createInMemoryPluginHostExecutor(
  handlers: ReadonlyMap<string, PluginJobHandlerRegistration>,
  options: PluginHostExecutorOptions = {}
): PluginHostExecutor {
  return new PluginHostExecutor(
    { runner: new PluginJobRunner(new InMemoryPluginJobStore()), handlers },
    options
  );
}
