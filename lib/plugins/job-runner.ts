/**
 * Server-only job lifecycle boundary for plugin-backed work.
 *
 * This module deliberately has no MongoDB, Next.js, or provider imports.  The
 * in-memory store is useful for contract tests and local workers; production
 * code should provide a PluginJobStore backed by an atomic durable store.
 * `lib/pan/scheduler.ts` can adopt this boundary incrementally by mapping its
 * existing run document to PluginJobRun instead of copying another state
 * machine.
 */

import { randomUUID } from "node:crypto";
import type { AuditActorDoc } from "@/lib/compliance-types";
import {
  clonePluginJobEventRecord,
  type PluginJobEventRecord,
} from "@/lib/plugins/job-events";

export const PLUGIN_JOB_STATUSES = [
  "queued",
  "running",
  "retry_waiting",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;

export type PluginJobStatus = (typeof PLUGIN_JOB_STATUSES)[number];
export type PluginJobTerminalStatus =
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export const PLUGIN_JOB_CONTROL_MODES = ["host", "external-report"] as const;
export type PluginJobControlMode = (typeof PLUGIN_JOB_CONTROL_MODES)[number];
export const LEGACY_EXTERNAL_REPORT_JOB_ID = "legacy.external-report";

export const PLUGIN_JOB_ERROR_CODES = {
  NOT_FOUND: "JOB_NOT_FOUND",
  IDEMPOTENCY_CONFLICT: "JOB_IDEMPOTENCY_CONFLICT",
  LEASE_BUSY: "JOB_LEASE_BUSY",
  LEASE_REQUIRED: "JOB_LEASE_REQUIRED",
  INVALID_STATE: "JOB_INVALID_STATE",
  INVALID_PROGRESS: "JOB_INVALID_PROGRESS",
  RETRY_EXHAUSTED: "JOB_RETRY_EXHAUSTED",
  RETRY_NOT_DUE: "JOB_RETRY_NOT_DUE",
  CONFLICT: "JOB_CONFLICT",
} as const;

export type PluginJobErrorCode =
  (typeof PLUGIN_JOB_ERROR_CODES)[keyof typeof PLUGIN_JOB_ERROR_CODES];

export class PluginJobError extends Error {
  readonly code: PluginJobErrorCode;

  constructor(code: PluginJobErrorCode, message: string) {
    super(message);
    this.name = "PluginJobError";
    this.code = code;
  }
}

export interface PluginJobProgress {
  readonly total: number;
  readonly processed: number;
  readonly created: number;
  readonly failed: number;
  readonly skipped: number;
}

export type PluginJobProgressPatch = Partial<PluginJobProgress>;

export interface PluginJobRetryPolicy {
  /** Maximum number of executions, including the first attempt. */
  readonly maxAttempts: number;
  /** Delay before the first retry. Delays grow exponentially. */
  readonly baseDelayMs: number;
  /** Upper bound for an individual retry delay. */
  readonly maxDelayMs: number;
}

export interface PluginJobLease {
  readonly owner: string;
  /** Random capability token regenerated for every claim; never expose it. */
  readonly token: string;
  /** Monotonic fencing value copied from the run at claim time. */
  readonly fence: number;
  readonly acquired_at: string;
  readonly heartbeat_at: string;
  readonly expires_at: string;
}

export interface PluginJobLeaseCredential {
  readonly owner: string;
  readonly token: string;
  readonly fence: number;
}

export interface PluginJobErrorSnapshot {
  readonly code?: string;
  readonly message: string;
  readonly retryable?: boolean;
}

/** Provider-neutral durable shape. Field names intentionally match scheduler documents. */
export interface PluginJobRun {
  readonly run_id: string;
  readonly job_id: string;
  readonly control_mode: PluginJobControlMode;
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly profile_id: string;
  readonly profile: string;
  readonly config_version: string;
  readonly actor: AuditActorDoc;
  readonly idempotency_key: string;
  readonly status: PluginJobStatus;
  readonly attempt: number;
  readonly retry_policy: PluginJobRetryPolicy;
  readonly cursor?: string;
  readonly next_retry_at?: string;
  readonly lease?: PluginJobLease;
  /** Monotonic generation incremented on every host claim. */
  readonly lease_fence: number;
  readonly heartbeat_at?: string;
  readonly cancel_requested: boolean;
  readonly progress: PluginJobProgress;
  readonly error?: PluginJobErrorSnapshot;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Internal durable outbox entry; never expose it through an admin DTO. */
  readonly pending_event_receipt?: PluginJobEventRecord;
  /** Monotonic revision used by durable adapters for compare-and-swap updates. */
  readonly revision: number;
  readonly expires_at?: Date;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at?: string;
  readonly finished_at?: string;
}

export interface PluginJobEnqueueInput {
  readonly runId?: string;
  readonly jobId: string;
  /** Enqueue creates host-controlled work; external reports use ingestion. */
  readonly controlMode?: "host";
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly profileId: string;
  readonly profile?: string;
  readonly configVersion: string;
  readonly actor: AuditActorDoc;
  readonly idempotencyKey: string;
  readonly cursor?: string;
  readonly progress?: Partial<PluginJobProgress>;
  readonly retryPolicy?: Partial<PluginJobRetryPolicy>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PluginJobRunnerOptions {
  readonly now?: () => Date;
  readonly defaultRetryPolicy?: Partial<PluginJobRetryPolicy>;
  readonly defaultLeaseTtlMs?: number;
  readonly retentionMs?: number;
}

export interface PluginJobStartOptions {
  readonly owner: string;
  readonly leaseTtlMs?: number;
}

export interface PluginJobClaimOptions {
  readonly owner: string;
  readonly leaseTtlMs?: number;
}

export interface PluginJobStoreClaimInput {
  readonly runId?: string;
  readonly owner: string;
  readonly token: string;
  /** Deterministic clock for in-memory stores; durable stores use their server clock. */
  readonly now: string;
  readonly leaseTtlMs: number;
}

export interface PluginJobFinishInput {
  readonly status: PluginJobTerminalStatus;
  readonly error?: PluginJobErrorSnapshot;
}

/**
 * A durable implementation must make `create` idempotent and `update` atomic
 * at the supplied revision. This lets the runner remain storage-neutral while
 * Mongo, Redis, or a queue-backed adapter handles cross-process races.
 */
export interface PluginJobStore {
  create(run: PluginJobRun): Promise<PluginJobRun>;
  get(runId: string): Promise<PluginJobRun | null>;
  findByIdempotencyKey(key: string): Promise<PluginJobRun | null>;
  /** Atomically finds and claims one eligible host-controlled run. */
  claimNext(input: PluginJobStoreClaimInput): Promise<PluginJobRun | null>;
  /** Finalize expired host leases that can no longer be reclaimed. */
  recoverExpiredLeases(now: string): Promise<number>;
  /** Renew a lease atomically using the durable store's authoritative clock. */
  renewLease(
    runId: string,
    expectedRevision: number,
    credential: PluginJobLeaseCredential,
    leaseTtlMs: number,
    now: string
  ): Promise<PluginJobRun | null>;
  update(
    runId: string,
    expectedRevision: number,
    mutate: (current: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun | null>;
  updateWithLease(
    runId: string,
    expectedRevision: number,
    credential: PluginJobLeaseCredential,
    now: string,
    mutate: (current: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun | null>;
  list(options?: {
    status?: PluginJobStatus;
    limit?: number;
  }): Promise<PluginJobRun[]>;
}

export interface PluginJobRunnerPort {
  enqueue(input: PluginJobEnqueueInput): Promise<PluginJobRun>;
  get(runId: string): Promise<PluginJobRun | null>;
  list(options?: { status?: PluginJobStatus; limit?: number }): Promise<PluginJobRun[]>;
  claimNext(options: PluginJobClaimOptions): Promise<PluginJobRun | null>;
  start(options: PluginJobStartOptions & { runId: string }): Promise<PluginJobRun>;
  heartbeat(
    runId: string,
    credential: PluginJobLeaseCredential,
    leaseTtlMs?: number
  ): Promise<PluginJobRun>;
  requestCancel(runId: string): Promise<PluginJobRun | null>;
  isCancellationRequested(runId: string): Promise<boolean>;
  reportProgress(
    runId: string,
    credential: PluginJobLeaseCredential,
    patch: PluginJobProgressPatch
  ): Promise<PluginJobRun>;
  setCursor(
    runId: string,
    credential: PluginJobLeaseCredential,
    cursor?: string
  ): Promise<PluginJobRun>;
  retry(
    runId: string,
    options?: { reason?: PluginJobErrorSnapshot; now?: Date }
  ): Promise<PluginJobRun>;
  finish(
    runId: string,
    credential: PluginJobLeaseCredential,
    input: PluginJobFinishInput
  ): Promise<PluginJobRun>;
}

const DEFAULT_RETRY_POLICY: PluginJobRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
};
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const MAX_LEASE_TTL_MS = 30 * 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_RETENTION_MS = 365 * 24 * 60 * 60_000;
const MAX_CURSOR_LENGTH = 4096;
const MAX_METADATA_KEYS = 100;
const MAX_CANCEL_CAS_ATTEMPTS = 10;
const JOB_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} 不能为空`);
  }
  return value.trim();
}

export function normalizePluginJobId(value: string): string {
  const jobId = assertNonEmpty(value, "jobId");
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new TypeError("jobId 必须是 1 到 100 位小写字母、数字、点、下划线或连字符，且首尾为字母或数字");
  }
  return jobId;
}

function normalizeControlMode(value: PluginJobControlMode | undefined): PluginJobControlMode {
  const mode = value ?? "host";
  if (!PLUGIN_JOB_CONTROL_MODES.includes(mode)) {
    throw new TypeError("controlMode 必须是 host 或 external-report");
  }
  return mode;
}

function boundedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}

function normalizeRetryPolicy(
  input: Partial<PluginJobRetryPolicy> | undefined,
  fallback: PluginJobRetryPolicy = DEFAULT_RETRY_POLICY
): PluginJobRetryPolicy {
  return {
    maxAttempts: boundedInteger(input?.maxAttempts ?? fallback.maxAttempts, "maxAttempts", 1, 20),
    baseDelayMs: boundedInteger(input?.baseDelayMs ?? fallback.baseDelayMs, "baseDelayMs", 0, MAX_RETRY_DELAY_MS),
    maxDelayMs: boundedInteger(input?.maxDelayMs ?? fallback.maxDelayMs, "maxDelayMs", 0, MAX_RETRY_DELAY_MS),
  };
}

export function calculatePluginJobRetryDelayMs(
  policy: PluginJobRetryPolicy,
  attempt: number
): number {
  boundedInteger(attempt, "attempt", 1, 20);
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(policy.maxDelayMs, Math.max(0, Math.floor(exponential)));
}

function normalizeProgress(
  patch: PluginJobProgressPatch | undefined,
  base: PluginJobProgress = { total: 0, processed: 0, created: 0, failed: 0, skipped: 0 }
): PluginJobProgress {
  const result = {
    total: patch?.total ?? base.total,
    processed: patch?.processed ?? base.processed,
    created: patch?.created ?? base.created,
    failed: patch?.failed ?? base.failed,
    skipped: patch?.skipped ?? base.skipped,
  };
  for (const [key, value] of Object.entries(result)) {
    boundedInteger(value, `progress.${key}`, 0, Number.MAX_SAFE_INTEGER);
  }
  return result;
}

function cloneRun(run: PluginJobRun): PluginJobRun {
  return {
    ...run,
    actor: { ...run.actor },
    retry_policy: { ...run.retry_policy },
    ...(run.lease ? { lease: { ...run.lease } } : {}),
    progress: { ...run.progress },
    ...(run.error ? { error: { ...run.error } } : {}),
    metadata: { ...run.metadata },
    ...(run.pending_event_receipt
      ? {
          pending_event_receipt: clonePluginJobEventRecord(
            run.pending_event_receipt
          ),
        }
      : {}),
  };
}

function isLeaseActive(run: PluginJobRun, now: Date): boolean {
  return Boolean(run.lease && Date.parse(run.lease.expires_at) > now.getTime());
}

function normalizeLeaseCredential(
  credential: PluginJobLeaseCredential
): PluginJobLeaseCredential {
  if (!credential || typeof credential !== "object") {
    throw new TypeError("lease credential 不能为空");
  }
  return {
    owner: assertNonEmpty(credential.owner, "lease.owner"),
    token: assertNonEmpty(credential.token, "lease.token"),
    fence: boundedInteger(
      credential.fence,
      "lease.fence",
      1,
      Number.MAX_SAFE_INTEGER
    ),
  };
}

function isClaimEligible(run: PluginJobRun, now: Date): boolean {
  if (
    run.control_mode !== "host" ||
    run.cancel_requested ||
    run.attempt >= run.retry_policy.maxAttempts
  ) {
    return false;
  }
  if (run.status === "queued") return true;
  if (run.status === "retry_waiting") {
    const dueAt = run.next_retry_at ? Date.parse(run.next_retry_at) : NaN;
    return Number.isFinite(dueAt) && dueAt <= now.getTime();
  }
  if (run.status === "running" && run.lease) {
    const expiresAt = Date.parse(run.lease.expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
  }
  return false;
}

function claimRun(
  run: PluginJobRun,
  input: PluginJobStoreClaimInput
): PluginJobRun {
  const fence = boundedInteger(
    run.lease_fence + 1,
    "lease_fence",
    1,
    Number.MAX_SAFE_INTEGER
  );
  return {
    ...run,
    status: "running",
    attempt: run.attempt + 1,
    lease_fence: fence,
    lease: {
      owner: input.owner,
      token: input.token,
      fence,
      acquired_at: input.now,
      heartbeat_at: input.now,
      expires_at: new Date(Date.parse(input.now) + input.leaseTtlMs).toISOString(),
    },
    heartbeat_at: input.now,
    next_retry_at: undefined,
    revision: run.revision + 1,
    updated_at: input.now,
    ...(run.started_at ? {} : { started_at: input.now }),
  };
}

function assertLeaseTtl(ttlMs: number): number {
  return boundedInteger(ttlMs, "leaseTtlMs", 100, MAX_LEASE_TTL_MS);
}

function assertRetentionMs(retentionMs: number): number {
  return boundedInteger(retentionMs, "retentionMs", 60_000, MAX_RETENTION_MS);
}

function withUpdatedTimestamp(run: PluginJobRun, now: string): PluginJobRun {
  return { ...run, revision: run.revision + 1, updated_at: now };
}

function sameJobIdempotencyIdentity(
  left: PluginJobRun,
  right: PluginJobRun
): boolean {
  return left.job_id === right.job_id &&
    left.control_mode === right.control_mode &&
    left.plugin_id === right.plugin_id &&
    left.plugin_version === right.plugin_version &&
    left.profile_id === right.profile_id &&
    left.config_version === right.config_version;
}

function sameJobImmutableIdentity(
  left: PluginJobRun,
  right: PluginJobRun
): boolean {
  return left.run_id === right.run_id &&
    left.idempotency_key === right.idempotency_key &&
    sameJobIdempotencyIdentity(left, right);
}

/**
 * Storage-neutral lifecycle facade. It is intentionally small enough for the
 * current pan scheduler to adopt one operation at a time.
 */
export class PluginJobRunner implements PluginJobRunnerPort {
  private readonly now: () => Date;
  private readonly defaultRetryPolicy: PluginJobRetryPolicy;
  private readonly defaultLeaseTtlMs: number;
  private readonly retentionMs: number;

  constructor(
    private readonly store: PluginJobStore,
    options: PluginJobRunnerOptions = {}
  ) {
    this.now = options.now || (() => new Date());
    this.defaultRetryPolicy = normalizeRetryPolicy(options.defaultRetryPolicy);
    this.defaultLeaseTtlMs = assertLeaseTtl(options.defaultLeaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
    this.retentionMs = assertRetentionMs(options.retentionMs ?? DEFAULT_RETENTION_MS);
  }

  async enqueue(input: PluginJobEnqueueInput): Promise<PluginJobRun> {
    const idempotencyKey = assertNonEmpty(input.idempotencyKey, "idempotencyKey");
    const jobId = normalizePluginJobId(input.jobId);
    const controlMode = normalizeControlMode(input.controlMode);
    if (jobId === LEGACY_EXTERNAL_REPORT_JOB_ID) {
      throw new TypeError("新的宿主任务不能使用 legacy.external-report jobId");
    }
    const pluginId = assertNonEmpty(input.pluginId, "pluginId");
    const pluginVersion = assertNonEmpty(input.pluginVersion, "pluginVersion");
    const profileId = assertNonEmpty(input.profileId, "profileId");
    const profile = assertNonEmpty(input.profile || input.profileId, "profile");
    const configVersion = assertNonEmpty(input.configVersion, "configVersion");
    const existing = await this.store.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (
        existing.job_id !== jobId ||
        existing.control_mode !== controlMode ||
        existing.plugin_id !== pluginId ||
        existing.plugin_version !== pluginVersion ||
        existing.profile_id !== profileId ||
        existing.config_version !== configVersion
      ) {
        throw new PluginJobError(
          PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "幂等键已经绑定到其他任务、插件或画像"
        );
      }
      return cloneRun(existing);
    }

    const nowDate = this.now();
    const now = nowDate.toISOString();
    const metadata = { ...(input.metadata || {}) };
    if (Object.keys(metadata).length > MAX_METADATA_KEYS) {
      throw new RangeError(`metadata 最多支持 ${MAX_METADATA_KEYS} 个字段`);
    }
    const run: PluginJobRun = {
      run_id: input.runId || randomUUID(),
      job_id: jobId,
      control_mode: controlMode,
      plugin_id: pluginId,
      plugin_version: pluginVersion,
      profile_id: profileId,
      profile,
      config_version: configVersion,
      actor: { ...input.actor },
      idempotency_key: idempotencyKey,
      status: "queued",
      attempt: 0,
      retry_policy: normalizeRetryPolicy(input.retryPolicy, this.defaultRetryPolicy),
      ...(input.cursor !== undefined ? { cursor: assertNonEmpty(input.cursor, "cursor") } : {}),
      cancel_requested: false,
      lease_fence: 0,
      progress: normalizeProgress(input.progress),
      metadata,
      revision: 0,
      expires_at: new Date(nowDate.getTime() + this.retentionMs),
      created_at: now,
      updated_at: now,
    };
    return cloneRun(await this.store.create(run));
  }

  async get(runId: string): Promise<PluginJobRun | null> {
    const run = await this.store.get(assertNonEmpty(runId, "runId"));
    return run ? cloneRun(run) : null;
  }

  async list(options: { status?: PluginJobStatus; limit?: number } = {}): Promise<PluginJobRun[]> {
    const limit = options.limit === undefined
      ? 100
      : boundedInteger(options.limit, "limit", 1, 500);
    return (await this.store.list({ ...options, limit })).map(cloneRun);
  }

  async claimNext(options: PluginJobClaimOptions): Promise<PluginJobRun | null> {
    const claimed = await this.claim(options);
    return claimed ? cloneRun(claimed) : null;
  }

  async start(options: PluginJobStartOptions & { runId: string }): Promise<PluginJobRun> {
    const runId = assertNonEmpty(options.runId, "runId");
    const claimed = await this.claim(options, runId);
    if (claimed) return cloneRun(claimed);

    const current = await this.require(runId);
    const nowDate = this.now();
    if (current.control_mode !== "host") {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "外部上报任务不能由宿主领取");
    }
    if (current.status === "cancelled" || current.cancel_requested) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "任务已取消");
    }
    if (["succeeded", "partial", "failed"].includes(current.status)) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "终态任务不能直接启动，请先重试");
    }
    if (current.status === "retry_waiting") {
      const dueAt = current.next_retry_at ? Date.parse(current.next_retry_at) : NaN;
      if (Number.isFinite(dueAt) && dueAt > nowDate.getTime()) {
        throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.RETRY_NOT_DUE, "重试退避尚未结束");
      }
    }
    if (current.status === "running" && isLeaseActive(current, nowDate)) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.LEASE_BUSY, "任务租约已被 worker 占用");
    }
    if (current.status === "running" && (!current.lease || !Number.isFinite(Date.parse(current.lease.expires_at)))) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED, "运行中的任务没有可接管的租约");
    }
    if (current.attempt >= current.retry_policy.maxAttempts) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED, "任务已达到最大执行次数");
    }
    throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.CONFLICT, "任务领取条件已被其他 worker 修改");
  }

  async heartbeat(
    runId: string,
    credential: PluginJobLeaseCredential,
    leaseTtlMs?: number
  ): Promise<PluginJobRun> {
    const current = await this.require(runId);
    const leaseCredential = this.assertActiveLease(current, credential);
    const now = this.now().toISOString();
    const ttlMs = assertLeaseTtl(leaseTtlMs ?? this.defaultLeaseTtlMs);
    const updated = await this.store.renewLease(
      current.run_id,
      current.revision,
      leaseCredential,
      ttlMs,
      now
    );
    if (!updated) {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED,
        "任务租约已过期、被接管或状态已改变"
      );
    }
    return cloneRun(updated);
  }

  async requestCancel(runId: string): Promise<PluginJobRun | null> {
    const normalizedRunId = assertNonEmpty(runId, "runId");
    for (let attempt = 0; attempt < MAX_CANCEL_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.store.get(normalizedRunId);
      if (!current) return null;
      if (
        current.cancel_requested ||
        ["succeeded", "partial", "failed", "cancelled"].includes(current.status)
      ) {
        return cloneRun(current);
      }
      const now = this.now().toISOString();
      const updated = await this.store.update(
        current.run_id,
        current.revision,
        (run) => ({
          ...withUpdatedTimestamp(run, now),
          cancel_requested: true,
          ...(run.status === "queued" || run.status === "retry_waiting"
            ? { status: "cancelled" as const, finished_at: now, lease: undefined }
            : {}),
        })
      );
      if (updated) return cloneRun(updated);
    }
    throw new PluginJobError(
      PLUGIN_JOB_ERROR_CODES.CONFLICT,
      "任务持续被其他 worker 修改，取消请求未能提交"
    );
  }

  async isCancellationRequested(runId: string): Promise<boolean> {
    const run = await this.store.get(assertNonEmpty(runId, "runId"));
    return Boolean(run?.cancel_requested || run?.status === "cancelled");
  }

  async reportProgress(
    runId: string,
    credential: PluginJobLeaseCredential,
    patch: PluginJobProgressPatch
  ): Promise<PluginJobRun> {
    const current = await this.require(runId);
    const now = this.now();
    const leaseCredential = this.assertActiveLease(current, credential);
    const next = normalizeProgress(patch, current.progress);
    for (const key of Object.keys(current.progress) as (keyof PluginJobProgress)[]) {
      if (next[key] < current.progress[key]) {
        throw new PluginJobError(
          PLUGIN_JOB_ERROR_CODES.INVALID_PROGRESS,
          `progress.${key} 不能倒退`
        );
      }
    }
    const updated = await this.updateWithActiveLease(current, leaseCredential, now.toISOString(), (run) => ({
      ...withUpdatedTimestamp(run, now.toISOString()),
      progress: next,
    }));
    return cloneRun(updated);
  }

  async setCursor(
    runId: string,
    credential: PluginJobLeaseCredential,
    cursor?: string
  ): Promise<PluginJobRun> {
    const current = await this.require(runId);
    const now = this.now();
    const leaseCredential = this.assertActiveLease(current, credential);
    if (cursor !== undefined && (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)) {
      throw new RangeError(`cursor 长度必须是 1 到 ${MAX_CURSOR_LENGTH}`);
    }
    const updated = await this.updateWithActiveLease(current, leaseCredential, now.toISOString(), (run) => ({
      ...withUpdatedTimestamp(run, now.toISOString()),
      cursor,
    }));
    return cloneRun(updated);
  }

  async retry(
    runId: string,
    options: { reason?: PluginJobErrorSnapshot; now?: Date } = {}
  ): Promise<PluginJobRun> {
    const current = await this.require(runId);
    if (current.status !== "failed" && current.status !== "partial") {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "只有失败或部分完成的任务可以重试");
    }
    if (current.cancel_requested) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "已取消的任务不能重试");
    }
    if (current.attempt >= current.retry_policy.maxAttempts) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED, "任务已达到最大执行次数");
    }
    const nowDate = options.now || this.now();
    const now = nowDate.toISOString();
    const delayMs = calculatePluginJobRetryDelayMs(current.retry_policy, Math.max(current.attempt, 1));
    const nextRetryAt = new Date(nowDate.getTime() + delayMs).toISOString();
    const updated = await this.update(current, (run) => ({
      ...withUpdatedTimestamp(run, now),
      status: delayMs > 0 ? "retry_waiting" : "queued",
      next_retry_at: delayMs > 0 ? nextRetryAt : undefined,
      lease: undefined,
      ...(options.reason ? { error: options.reason } : {}),
      finished_at: undefined,
    }));
    return cloneRun(updated);
  }

  async finish(
    runId: string,
    credential: PluginJobLeaseCredential,
    input: PluginJobFinishInput
  ): Promise<PluginJobRun> {
    const current = await this.require(runId);
    const nowDate = this.now();
    const leaseCredential = this.assertActiveLease(current, credential);
    if (current.cancel_requested && input.status !== "cancelled") {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "任务已请求取消，不能标记为成功");
    }
    const now = nowDate.toISOString();
    const updated = await this.updateWithActiveLease(current, leaseCredential, now, (run) => ({
      ...withUpdatedTimestamp(run, now),
      status: input.status,
      lease: undefined,
      ...(input.status === "cancelled" ? { cancel_requested: true } : {}),
      ...(input.error ? { error: input.error } : { error: undefined }),
      finished_at: now,
    }));
    return cloneRun(updated);
  }

  private async claim(
    options: PluginJobClaimOptions,
    runId?: string
  ): Promise<PluginJobRun | null> {
    const owner = assertNonEmpty(options.owner, "owner");
    const ttlMs = assertLeaseTtl(
      options.leaseTtlMs ?? this.defaultLeaseTtlMs
    );
    const nowDate = this.now();
    const now = nowDate.toISOString();
    await this.store.recoverExpiredLeases(now);
    return this.store.claimNext({
      ...(runId ? { runId } : {}),
      owner,
      token: randomUUID(),
      now,
      leaseTtlMs: ttlMs,
    });
  }

  private async require(runId: string): Promise<PluginJobRun> {
    const run = await this.store.get(runId);
    if (!run) throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.NOT_FOUND, `任务不存在：${runId}`);
    return run;
  }

  private async update(
    current: PluginJobRun,
    mutate: (run: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun> {
    const updated = await this.store.update(current.run_id, current.revision, mutate);
    if (!updated) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.CONFLICT, "任务状态已被其他 worker 修改");
    }
    return updated;
  }

  private async updateWithActiveLease(
    current: PluginJobRun,
    credential: PluginJobLeaseCredential,
    now: string,
    mutate: (run: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun> {
    const updated = await this.store.updateWithLease(
      current.run_id,
      current.revision,
      credential,
      now,
      mutate
    );
    if (!updated) {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED,
        "任务租约已过期、被接管或状态已改变"
      );
    }
    return updated;
  }

  private assertActiveLease(
    run: PluginJobRun,
    credential: PluginJobLeaseCredential
  ): PluginJobLeaseCredential {
    const normalized = normalizeLeaseCredential(credential);
    if (
      run.status !== "running" ||
      !run.lease ||
      run.lease.owner !== normalized.owner ||
      run.lease.token !== normalized.token ||
      run.lease.fence !== normalized.fence ||
      run.lease_fence !== normalized.fence
    ) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED, "当前 worker 没有有效任务租约");
    }
    return normalized;
  }
}

/** Small CAS-backed store for unit tests and single-process workers. */
export class InMemoryPluginJobStore implements PluginJobStore {
  private readonly runs = new Map<string, PluginJobRun>();
  private readonly idempotency = new Map<string, string>();

  async create(run: PluginJobRun): Promise<PluginJobRun> {
    const existingId = this.idempotency.get(run.idempotency_key);
    if (existingId) {
      const existing = this.runs.get(existingId);
      if (existing) {
        if (!sameJobIdempotencyIdentity(existing, run)) {
          throw new PluginJobError(
            PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "幂等键已经绑定到其他任务、插件或画像"
          );
        }
        return cloneRun(existing);
      }
    }
    if (this.runs.has(run.run_id)) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT, "run_id 已存在");
    }
    const stored = cloneRun(run);
    this.runs.set(run.run_id, stored);
    this.idempotency.set(run.idempotency_key, run.run_id);
    return cloneRun(stored);
  }

  async get(runId: string): Promise<PluginJobRun | null> {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : null;
  }

  async findByIdempotencyKey(key: string): Promise<PluginJobRun | null> {
    const runId = this.idempotency.get(key);
    return runId ? this.get(runId) : null;
  }

  async claimNext(input: PluginJobStoreClaimInput): Promise<PluginJobRun | null> {
    const now = new Date(input.now);
    const candidates = [...this.runs.values()]
      .filter((run) => (!input.runId || run.run_id === input.runId) && isClaimEligible(run, now))
      .sort((left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.run_id.localeCompare(right.run_id)
      );
    const current = candidates[0];
    if (!current) return null;
    const next = claimRun(cloneRun(current), input);
    this.runs.set(next.run_id, cloneRun(next));
    return cloneRun(next);
  }

  async recoverExpiredLeases(now: string): Promise<number> {
    const nowDate = new Date(now);
    let recovered = 0;
    for (const [runId, current] of this.runs) {
      const expired = current.lease &&
        Number.isFinite(Date.parse(current.lease.expires_at)) &&
        Date.parse(current.lease.expires_at) <= nowDate.getTime();
      const exhausted = current.attempt >= current.retry_policy.maxAttempts;
      if (
        current.control_mode !== "host" ||
        current.status !== "running" ||
        !expired ||
        (!current.cancel_requested && !exhausted)
      ) {
        continue;
      }
      const next: PluginJobRun = {
        ...withUpdatedTimestamp(current, now),
        status: current.cancel_requested ? "cancelled" : "failed",
        lease: undefined,
        finished_at: now,
        ...(current.cancel_requested
          ? { error: undefined }
          : {
              error: {
                code: PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED,
                message: "任务租约已过期且执行次数已耗尽",
                retryable: false,
              },
            }),
      };
      this.runs.set(runId, cloneRun(next));
      recovered += 1;
    }
    return recovered;
  }

  async renewLease(
    runId: string,
    expectedRevision: number,
    credential: PluginJobLeaseCredential,
    leaseTtlMs: number,
    now: string
  ): Promise<PluginJobRun | null> {
    const nowDate = new Date(now);
    return this.updateWithLease(
      runId,
      expectedRevision,
      credential,
      now,
      (run) => ({
        ...withUpdatedTimestamp(run, now),
        heartbeat_at: now,
        lease: {
          ...run.lease!,
          heartbeat_at: now,
          expires_at: new Date(nowDate.getTime() + leaseTtlMs).toISOString(),
        },
      })
    );
  }

  async update(
    runId: string,
    expectedRevision: number,
    mutate: (current: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun | null> {
    const current = this.runs.get(runId);
    if (!current || current.revision !== expectedRevision) return null;
    const next = mutate(cloneRun(current));
    if (!sameJobImmutableIdentity(current, next)) {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "任务更新不能改变不可变身份"
      );
    }
    const stored = cloneRun(next);
    this.runs.set(runId, stored);
    return cloneRun(stored);
  }

  async updateWithLease(
    runId: string,
    expectedRevision: number,
    credential: PluginJobLeaseCredential,
    now: string,
    mutate: (current: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun | null> {
    const current = this.runs.get(runId);
    const expiresAt = current?.lease
      ? Date.parse(current.lease.expires_at)
      : NaN;
    const comparedAt = Date.parse(now);
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.status !== "running" ||
      !current.lease ||
      current.lease.owner !== credential.owner ||
      current.lease.token !== credential.token ||
      current.lease.fence !== credential.fence ||
      current.lease_fence !== credential.fence ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(comparedAt) ||
      expiresAt <= comparedAt
    ) {
      return null;
    }
    const next = mutate(cloneRun(current));
    if (!sameJobImmutableIdentity(current, next)) {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "任务更新不能改变不可变身份"
      );
    }
    this.runs.set(runId, cloneRun(next));
    return cloneRun(next);
  }

  async list(options: { status?: PluginJobStatus; limit?: number } = {}): Promise<PluginJobRun[]> {
    const limit = options.limit || 100;
    return [...this.runs.values()]
      .filter((run) => !options.status || run.status === options.status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(cloneRun);
  }
}

export function createInMemoryPluginJobRunner(
  options: PluginJobRunnerOptions = {}
): PluginJobRunner {
  return new PluginJobRunner(new InMemoryPluginJobStore(), options);
}
