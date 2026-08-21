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
  readonly acquired_at: string;
  readonly heartbeat_at: string;
  readonly expires_at: string;
}

export interface PluginJobErrorSnapshot {
  readonly code?: string;
  readonly message: string;
  readonly retryable?: boolean;
}

/** Provider-neutral durable shape. Field names intentionally match scheduler documents. */
export interface PluginJobRun {
  readonly run_id: string;
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
  readonly heartbeat_at?: string;
  readonly cancel_requested: boolean;
  readonly progress: PluginJobProgress;
  readonly error?: PluginJobErrorSnapshot;
  readonly metadata: Readonly<Record<string, unknown>>;
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
  update(
    runId: string,
    expectedRevision: number,
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
  start(options: PluginJobStartOptions & { runId: string }): Promise<PluginJobRun>;
  heartbeat(
    runId: string,
    owner: string,
    leaseTtlMs?: number
  ): Promise<PluginJobRun>;
  requestCancel(runId: string): Promise<PluginJobRun | null>;
  isCancellationRequested(runId: string): Promise<boolean>;
  reportProgress(
    runId: string,
    owner: string,
    patch: PluginJobProgressPatch
  ): Promise<PluginJobRun>;
  setCursor(runId: string, owner: string, cursor?: string): Promise<PluginJobRun>;
  retry(
    runId: string,
    options?: { reason?: PluginJobErrorSnapshot; now?: Date }
  ): Promise<PluginJobRun>;
  finish(
    runId: string,
    owner: string,
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

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} 不能为空`);
  }
  return value.trim();
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
  };
}

function isLeaseActive(run: PluginJobRun, now: Date): boolean {
  return Boolean(run.lease && Date.parse(run.lease.expires_at) > now.getTime());
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
    const pluginId = assertNonEmpty(input.pluginId, "pluginId");
    const pluginVersion = assertNonEmpty(input.pluginVersion, "pluginVersion");
    const profileId = assertNonEmpty(input.profileId, "profileId");
    const profile = assertNonEmpty(input.profile || input.profileId, "profile");
    const configVersion = assertNonEmpty(input.configVersion, "configVersion");
    const existing = await this.store.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (
        existing.plugin_id !== pluginId ||
        existing.plugin_version !== pluginVersion ||
        existing.profile_id !== profileId ||
        existing.config_version !== configVersion
      ) {
        throw new PluginJobError(
          PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "幂等键已经绑定到其他插件或画像"
        );
      }
      return cloneRun(existing);
    }

    const now = this.now().toISOString();
    const metadata = { ...(input.metadata || {}) };
    if (Object.keys(metadata).length > MAX_METADATA_KEYS) {
      throw new RangeError(`metadata 最多支持 ${MAX_METADATA_KEYS} 个字段`);
    }
    const run: PluginJobRun = {
      run_id: input.runId || randomUUID(),
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
      progress: normalizeProgress(input.progress),
      metadata,
      revision: 0,
      expires_at: new Date(this.now().getTime() + this.retentionMs),
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

  async start(options: PluginJobStartOptions & { runId: string }): Promise<PluginJobRun> {
    const runId = assertNonEmpty(options.runId, "runId");
    const owner = assertNonEmpty(options.owner, "owner");
    const ttlMs = assertLeaseTtl(options.leaseTtlMs ?? this.defaultLeaseTtlMs);
    const current = await this.require(runId);
    const nowDate = this.now();
    const now = nowDate.toISOString();

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
      if (current.lease?.owner !== owner) {
        throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.LEASE_BUSY, "任务租约已被其他 worker 占用");
      }
      return cloneRun(current);
    }
    if (current.status === "running" && !current.lease) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED, "运行中的任务没有可接管的租约");
    }

    // A lease expiry means the previous worker's side effects are unknown.
    // Count the takeover as another execution so maxAttempts remains a real
    // upper bound even when a worker repeatedly dies after writing effects.
    const shouldIncrementAttempt = true;
    if (shouldIncrementAttempt && current.attempt >= current.retry_policy.maxAttempts) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED, "任务已达到最大执行次数");
    }
    const lease: PluginJobLease = {
      owner,
      acquired_at: now,
      heartbeat_at: now,
      expires_at: new Date(nowDate.getTime() + ttlMs).toISOString(),
    };
    const updated = await this.update(current, (run) => ({
      ...withUpdatedTimestamp(run, now),
      status: "running",
      attempt: shouldIncrementAttempt ? run.attempt + 1 : run.attempt,
      lease,
      heartbeat_at: now,
      ...(run.started_at ? {} : { started_at: now }),
      next_retry_at: undefined,
    }));
    return cloneRun(updated);
  }

  async heartbeat(runId: string, owner: string, leaseTtlMs?: number): Promise<PluginJobRun> {
    const current = await this.require(runId);
    const nowDate = this.now();
    this.assertActiveLease(current, owner, nowDate);
    const now = nowDate.toISOString();
    const ttlMs = assertLeaseTtl(leaseTtlMs ?? this.defaultLeaseTtlMs);
    const updated = await this.update(current, (run) => ({
      ...withUpdatedTimestamp(run, now),
      heartbeat_at: now,
      lease: {
        ...run.lease!,
        heartbeat_at: now,
        expires_at: new Date(nowDate.getTime() + ttlMs).toISOString(),
      },
    }));
    return cloneRun(updated);
  }

  async requestCancel(runId: string): Promise<PluginJobRun | null> {
    const current = await this.store.get(assertNonEmpty(runId, "runId"));
    if (!current) return null;
    if (["succeeded", "partial", "failed", "cancelled"].includes(current.status)) {
      return cloneRun(current);
    }
    const now = this.now().toISOString();
    const updated = await this.update(current, (run) => ({
      ...withUpdatedTimestamp(run, now),
      cancel_requested: true,
      ...(run.status === "queued" || run.status === "retry_waiting"
        ? { status: "cancelled" as const, finished_at: now, lease: undefined }
        : {}),
    }));
    return cloneRun(updated);
  }

  async isCancellationRequested(runId: string): Promise<boolean> {
    const run = await this.store.get(assertNonEmpty(runId, "runId"));
    return Boolean(run?.cancel_requested || run?.status === "cancelled");
  }

  async reportProgress(
    runId: string,
    owner: string,
    patch: PluginJobProgressPatch
  ): Promise<PluginJobRun> {
    const current = await this.require(runId);
    this.assertActiveLease(current, owner, this.now());
    const next = normalizeProgress(patch, current.progress);
    for (const key of Object.keys(current.progress) as (keyof PluginJobProgress)[]) {
      if (next[key] < current.progress[key]) {
        throw new PluginJobError(
          PLUGIN_JOB_ERROR_CODES.INVALID_PROGRESS,
          `progress.${key} 不能倒退`
        );
      }
    }
    const updated = await this.update(current, (run) => ({
      ...withUpdatedTimestamp(run, this.now().toISOString()),
      progress: next,
    }));
    return cloneRun(updated);
  }

  async setCursor(runId: string, owner: string, cursor?: string): Promise<PluginJobRun> {
    const current = await this.require(runId);
    this.assertActiveLease(current, owner, this.now());
    if (cursor !== undefined && (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)) {
      throw new RangeError(`cursor 长度必须是 1 到 ${MAX_CURSOR_LENGTH}`);
    }
    const updated = await this.update(current, (run) => ({
      ...withUpdatedTimestamp(run, this.now().toISOString()),
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
    owner: string,
    input: PluginJobFinishInput
  ): Promise<PluginJobRun> {
    const current = await this.require(runId);
    this.assertActiveLease(current, owner, this.now());
    if (current.cancel_requested && input.status !== "cancelled") {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "任务已请求取消，不能标记为成功");
    }
    const now = this.now().toISOString();
    const updated = await this.update(current, (run) => ({
      ...withUpdatedTimestamp(run, now),
      status: input.status,
      lease: undefined,
      ...(input.status === "cancelled" ? { cancel_requested: true } : {}),
      ...(input.error ? { error: input.error } : { error: undefined }),
      finished_at: now,
    }));
    return cloneRun(updated);
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

  private assertActiveLease(run: PluginJobRun, owner: string, now: Date): void {
    if (
      run.status !== "running" ||
      !run.lease ||
      run.lease.owner !== assertNonEmpty(owner, "owner") ||
      !isLeaseActive(run, now)
    ) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED, "当前 worker 没有有效任务租约");
    }
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
      if (existing) return cloneRun(existing);
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

  async update(
    runId: string,
    expectedRevision: number,
    mutate: (current: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun | null> {
    const current = this.runs.get(runId);
    if (!current || current.revision !== expectedRevision) return null;
    const next = mutate(cloneRun(current));
    const stored = cloneRun(next);
    this.runs.set(runId, stored);
    return cloneRun(stored);
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
