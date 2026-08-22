import { createHash, timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import {
  PLUGIN_JOB_EVENT_KINDS,
  PLUGIN_JOB_EVENT_SCHEMA,
  PLUGIN_JOB_EVENT_STATUSES,
  isPluginJobEvent,
  isRfc3339DateTime,
  type PluginJobEvent,
  type PluginJobEventKind,
  type PluginJobEventMetadata,
  type PluginJobEventStatus,
} from "@/packages/kerkerker-plugin-contract/src/index";
import { pluginProfileRegistry } from "@/lib/plugins/builtin-profiles";
import { pluginRegistry } from "@/lib/plugins/builtin";
import {
  createPluginJobEventRecord,
  type PluginJobEventRecord,
} from "@/lib/plugins/job-events";
import { getMongoPluginJobEventStore } from "@/lib/plugins/mongo-job-event-store";
import { getMongoPluginJobStore } from "@/lib/plugins/mongo-job-store";
import {
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobProgress,
  type PluginJobRun,
} from "@/lib/plugins/job-runner";

export const JOB_REPORT_SCHEMA = PLUGIN_JOB_EVENT_SCHEMA;
export const JOB_REPORT_KINDS = PLUGIN_JOB_EVENT_KINDS;
export const JOB_REPORT_STATUSES = PLUGIN_JOB_EVENT_STATUSES;
export type JobReportKind = PluginJobEventKind;
export type JobReportStatus = PluginJobEventStatus;
export type JobReportMetadata = PluginJobEventMetadata;
export type JobReportEvent = PluginJobEvent;

export class PluginJobReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginJobReportValidationError";
  }
}

const MAX_ID_LENGTH = 200;
const MAX_PLUGIN_ID_LENGTH = 100;
const MAX_ERROR_LENGTH = 2_000;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const JOB_REPORT_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/;
const TERMINAL_STATUSES = new Set(["succeeded", "partial", "failed", "cancelled"]);

function nonEmpty(value: unknown, field: string, maxLength = MAX_ID_LENGTH): string {
  if (typeof value !== "string") {
    throw new RangeError(`${field} 格式无效`);
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    value !== trimmed ||
    Array.from(value).length > maxLength ||
    /\p{Cc}/u.test(value)
  ) {
    throw new RangeError(`${field} 格式无效`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${field} 必须是非负整数`);
  }
  return value as number;
}

function parseObject(
  value: unknown,
  field: string,
  allowedKeys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${field} 必须是对象`);
  }
  const parsed = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknownKey) throw new RangeError(`${field}.${unknownKey} 不属于任务事件契约`);
  return parsed;
}

export function parseJobReportEvent(value: unknown): JobReportEvent {
  const body = parseObject(value, "event", [
    "schema", "event_id", "sequence", "kind", "occurred_at",
    "metadata", "status", "progress", "error",
  ]);
  if (body.schema !== JOB_REPORT_SCHEMA) throw new RangeError("不支持的任务事件 schema");
  const kind = nonEmpty(body.kind, "kind", 20);
  if (!(JOB_REPORT_KINDS as readonly string[]).includes(kind)) throw new RangeError("kind 无效");
  const status = nonEmpty(body.status, "status", 20);
  if (!(JOB_REPORT_STATUSES as readonly string[]).includes(status)) throw new RangeError("status 无效");
  const occurredAt = nonEmpty(body.occurred_at, "occurred_at", 100);
  if (!RFC3339_PATTERN.test(occurredAt) || !isRfc3339DateTime(occurredAt)) {
    throw new RangeError("occurred_at 必须是 RFC3339 时间");
  }
  const metadata = parseObject(body.metadata, "metadata", [
    "run_id", "plugin_id", "plugin_version", "profile_id",
    "config_version", "actor", "attempt",
  ]);
  const progress = parseObject(body.progress, "progress", [
    "total", "processed", "created", "failed", "skipped",
  ]);
  const runId = nonEmpty(metadata.run_id, "metadata.run_id");
  if (!RUN_ID_PATTERN.test(runId)) throw new RangeError("metadata.run_id 格式无效");
  const pluginId = nonEmpty(metadata.plugin_id, "metadata.plugin_id", MAX_PLUGIN_ID_LENGTH);
  if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new RangeError("metadata.plugin_id 格式无效");
  const sequence = nonNegativeInteger(body.sequence, "sequence");
  const eventId = nonEmpty(body.event_id, "event_id", 240);
  if (eventId !== `${runId}:${sequence}`) throw new RangeError("event_id 必须由 run_id 和 sequence 组成");

  let parsedError: JobReportEvent["error"];
  if (body.error !== undefined) {
    const error = parseObject(body.error, "error", ["code", "message"]);
    parsedError = {
      ...(error.code !== undefined ? { code: nonEmpty(error.code, "error.code", 100) } : {}),
      message: nonEmpty(error.message, "error.message", MAX_ERROR_LENGTH),
    };
  }
  const parsed: JobReportEvent = {
    schema: JOB_REPORT_SCHEMA,
    event_id: eventId,
    sequence,
    kind: kind as JobReportKind,
    occurred_at: occurredAt,
    metadata: {
      run_id: runId,
      plugin_id: pluginId,
      plugin_version: nonEmpty(metadata.plugin_version, "metadata.plugin_version", 100),
      profile_id: nonEmpty(metadata.profile_id, "metadata.profile_id", 100),
      config_version: nonEmpty(metadata.config_version, "metadata.config_version", 100),
      actor: nonEmpty(metadata.actor, "metadata.actor", 200),
      attempt: Number.isSafeInteger(metadata.attempt) && (metadata.attempt as number) >= 1
        ? metadata.attempt as number
        : (() => { throw new RangeError("metadata.attempt 必须是正整数"); })(),
    },
    status: status as JobReportStatus,
    progress: {
      total: nonNegativeInteger(progress.total, "progress.total"),
      processed: nonNegativeInteger(progress.processed, "progress.processed"),
      created: nonNegativeInteger(progress.created, "progress.created"),
      failed: nonNegativeInteger(progress.failed, "progress.failed"),
      skipped: nonNegativeInteger(progress.skipped, "progress.skipped"),
    },
    ...(parsedError ? { error: parsedError } : {}),
  };
  if (parsed.kind === "started" && (parsed.sequence !== 0 || parsed.status !== "running")) {
    throw new RangeError("started 事件必须使用 sequence 0 和 running 状态");
  }
  if (parsed.kind !== "started" && parsed.sequence === 0) {
    throw new RangeError("sequence 0 只能用于 started 事件");
  }
  if (parsed.kind === "progress" && parsed.status !== "running") throw new RangeError("progress 事件必须是 running 状态");
  if (parsed.kind === "finished" && parsed.status === "running") throw new RangeError("finished 事件不能是 running 状态");
  if (parsed.kind !== "finished" && parsed.error) throw new RangeError("只有 finished 事件可以包含 error");
  if (parsed.kind === "finished" && parsed.status === "failed" && !parsed.error) throw new RangeError("failed 事件必须包含 error");
  if (parsed.kind === "finished" && parsed.status === "succeeded" && parsed.error) throw new RangeError("succeeded 事件不能包含 error");
  if (parsed.progress.processed > parsed.progress.total) throw new RangeError("progress.processed 不能超过 total");
  const categorized = parsed.progress.created + parsed.progress.failed + parsed.progress.skipped;
  if (!Number.isSafeInteger(categorized) || categorized !== parsed.progress.processed) {
    throw new RangeError("progress 分类计数之和必须等于 processed");
  }
  if (!isPluginJobEvent(parsed)) throw new RangeError("任务事件不符合公共契约");
  return parsed;
}

export function hasPluginJobReportToken(request: Pick<NextRequest, "headers">): boolean {
  const expected = process.env.KERKERKER_JOB_REPORT_TOKEN || "";
  if (!JOB_REPORT_TOKEN_PATTERN.test(expected)) return false;
  const match = (request.headers.get("authorization") || "")
    .match(/^Bearer ([A-Za-z0-9._~-]{32,512})$/i);
  if (!match) return false;
  const actual = Buffer.from(match[1]);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function requirePluginJobReportToken(request: Pick<NextRequest, "headers">): boolean {
  return hasPluginJobReportToken(request);
}

function eventHash(event: JobReportEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function sameIdentity(run: PluginJobRun, event: JobReportEvent): boolean {
  return run.run_id === event.metadata.run_id &&
    run.plugin_id === event.metadata.plugin_id &&
    run.plugin_version === event.metadata.plugin_version &&
    run.profile_id === event.metadata.profile_id &&
    run.config_version === event.metadata.config_version &&
    run.actor.type === "system" &&
    run.actor.id === event.metadata.actor &&
    run.attempt === event.metadata.attempt;
}

function isReportRun(run: PluginJobRun): boolean {
  return run.metadata.source === "job-report" &&
    Number.isSafeInteger(run.metadata.last_sequence) &&
    typeof run.metadata.last_event_id === "string" &&
    typeof run.metadata.last_event_hash === "string";
}

function assertReportIdentity(run: PluginJobRun, event: JobReportEvent): void {
  if (!sameIdentity(run, event) || !isReportRun(run)) {
    throw new PluginJobError(
      PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      "任务事件身份与已有任务不一致"
    );
  }
}

function monotonicProgress(current: PluginJobProgress, incoming: PluginJobProgress): PluginJobProgress {
  for (const key of ["total", "processed", "created", "failed", "skipped"] as const) {
    if (incoming[key] < current[key]) throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_PROGRESS, `progress.${key} 不能倒退`);
  }
  return incoming;
}

export interface JobReportIngestDependencies {
  get(runId: string): Promise<PluginJobRun | null>;
  create(run: PluginJobRun): Promise<PluginJobRun>;
  update(runId: string, revision: number, mutate: (run: PluginJobRun) => PluginJobRun): Promise<PluginJobRun | null>;
  appendEvent(record: PluginJobEventRecord): Promise<unknown>;
  now?(): Date;
}

export function defaultJobReportIngestDependencies(): JobReportIngestDependencies {
  return {
    async get(runId) { return (await getMongoPluginJobStore()).get(runId); },
    async create(run) { return (await getMongoPluginJobStore()).create(run); },
    async update(runId, revision, mutate) { return (await getMongoPluginJobStore()).update(runId, revision, mutate); },
    async appendEvent(record) { return (await getMongoPluginJobEventStore()).append(record); },
  };
}

function createPendingReceipt(
  event: JobReportEvent,
  eventHashValue: string,
  receivedAt: string,
  expiresAt: Date
): PluginJobEventRecord {
  return createPluginJobEventRecord({
    event,
    eventHash: eventHashValue,
    receivedAt,
    expiresAt,
  });
}

function assertPendingReceipt(run: PluginJobRun, receipt: PluginJobEventRecord): void {
  if (
    receipt.run_id !== run.run_id ||
    receipt.event_id !== run.metadata.last_event_id ||
    receipt.event_hash !== run.metadata.last_event_hash ||
    receipt.sequence !== run.metadata.last_sequence ||
    receipt.metadata.plugin_id !== run.plugin_id ||
    receipt.metadata.plugin_version !== run.plugin_version ||
    receipt.metadata.profile_id !== run.profile_id ||
    receipt.metadata.config_version !== run.config_version ||
    receipt.metadata.actor !== run.actor.id ||
    receipt.metadata.attempt !== run.attempt
  ) {
    throw new PluginJobError(
      PLUGIN_JOB_ERROR_CODES.CONFLICT,
      "任务事件 outbox 与运行快照不一致"
    );
  }
}

async function flushPendingReceipt(
  run: PluginJobRun,
  dependencies: JobReportIngestDependencies
): Promise<PluginJobRun> {
  let current = run;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const receipt = current.pending_event_receipt;
    if (!receipt) return current;
    if (!isReportRun(current)) {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.CONFLICT,
        "非上报任务不能包含 worker 事件 outbox"
      );
    }
    assertPendingReceipt(current, receipt);
    await dependencies.appendEvent(receipt);
    const cleared = await dependencies.update(
      current.run_id,
      current.revision,
      (snapshot) => {
        const pending = snapshot.pending_event_receipt;
        if (
          !pending ||
          pending.event_id !== receipt.event_id ||
          pending.event_hash !== receipt.event_hash
        ) {
          throw new PluginJobError(
            PLUGIN_JOB_ERROR_CODES.CONFLICT,
            "任务事件 outbox 在清理时发生变化"
          );
        }
        return {
          ...snapshot,
          pending_event_receipt: undefined,
          revision: snapshot.revision + 1,
        };
      }
    );
    if (cleared) return cleared;
    const winner = await dependencies.get(current.run_id);
    if (!winner) {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.CONFLICT,
        "任务事件 outbox 清理时运行记录消失"
      );
    }
    current = winner;
  }
  throw new PluginJobError(
    PLUGIN_JOB_ERROR_CODES.CONFLICT,
    "任务事件 outbox 持续发生并发冲突"
  );
}

function assertRegisteredSource(event: JobReportEvent): void {
  const plugin = pluginRegistry.get(event.metadata.plugin_id);
  if (!plugin) throw new PluginJobReportValidationError("任务事件的插件未注册");
  if (plugin.manifest.version !== event.metadata.plugin_version) {
    throw new PluginJobReportValidationError("任务事件的插件版本与注册版本不一致");
  }
  const profile = pluginProfileRegistry.get(event.metadata.profile_id);
  if (!profile) throw new PluginJobReportValidationError("任务事件的插件画像未注册");
  const isBound = Object.values(profile.capabilities).some((ids) =>
    ids?.includes(event.metadata.plugin_id)
  );
  if (!isBound) throw new PluginJobReportValidationError("任务事件的插件未绑定到指定画像");
}

export async function ingestPluginJobReport(
  event: JobReportEvent,
  dependencies: JobReportIngestDependencies = defaultJobReportIngestDependencies()
): Promise<PluginJobRun> {
  const incomingHash = eventHash(event);
  const receivedAtDate = dependencies.now?.() ?? new Date();
  const receivedAt = receivedAtDate.toISOString();
  let existing = await dependencies.get(event.metadata.run_id);
  if (!existing && event.kind !== "started") {
    throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.NOT_FOUND, "任务尚未开始");
  }
  if (!existing) {
    assertRegisteredSource(event);
    const expiresAt = new Date(
      receivedAtDate.getTime() + 30 * 24 * 60 * 60 * 1000
    );
    const receipt = createPendingReceipt(
      event,
      incomingHash,
      receivedAt,
      expiresAt
    );
    const run: PluginJobRun = {
      run_id: event.metadata.run_id,
      plugin_id: event.metadata.plugin_id,
      plugin_version: event.metadata.plugin_version,
      profile_id: event.metadata.profile_id,
      profile: event.metadata.profile_id,
      config_version: event.metadata.config_version,
      actor: { type: "system", id: event.metadata.actor },
      idempotency_key: `report:${event.metadata.run_id}`,
      status: "running",
      attempt: event.metadata.attempt,
      retry_policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      cancel_requested: false,
      progress: event.progress,
      metadata: {
        source: "job-report",
        last_sequence: event.sequence,
        last_event_id: event.event_id,
        last_event_hash: incomingHash,
        last_occurred_at: event.occurred_at,
        last_received_at: receivedAt,
      },
      pending_event_receipt: receipt,
      revision: 0,
      expires_at: expiresAt,
      created_at: receivedAt,
      updated_at: receivedAt,
      started_at: receivedAt,
    };
    const created = await dependencies.create(run);
    assertReportIdentity(created, event);
    if (created.metadata.last_event_id !== event.event_id || created.metadata.last_event_hash !== incomingHash) {
      throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT, "run_id 已绑定到其他任务事件");
    }
    return flushPendingReceipt(created, dependencies);
  }

  assertReportIdentity(existing, event);
  existing = await flushPendingReceipt(existing, dependencies);
  assertReportIdentity(existing, event);
  const lastSequence = existing.metadata.last_sequence as number;
  if (event.sequence < lastSequence) return existing;
  if (event.sequence === lastSequence) {
    if (existing.metadata.last_event_id === event.event_id && existing.metadata.last_event_hash === incomingHash) {
      return existing;
    }
    throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT, "相同 sequence 的任务事件内容不一致");
  }
  if (TERMINAL_STATUSES.has(existing.status)) {
    throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "终态任务不能继续接收事件");
  }
  if (event.kind === "started") {
    throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.INVALID_STATE, "任务已经开始");
  }

  const progress = monotonicProgress(existing.progress, event.progress);
  const nextStatus = event.kind === "finished" ? event.status : "running";
  const receipt = createPendingReceipt(
    event,
    incomingHash,
    receivedAt,
    existing.expires_at
      ? new Date(existing.expires_at)
      : new Date(receivedAtDate.getTime() + 30 * 24 * 60 * 60 * 1000)
  );
  const redactedError = receipt.error;
  const updated = await dependencies.update(event.metadata.run_id, existing.revision, (run) => ({
    ...run,
    status: nextStatus,
    progress,
    error: redactedError,
    metadata: {
      ...run.metadata,
      last_sequence: event.sequence,
      last_event_id: event.event_id,
      last_event_hash: incomingHash,
      last_occurred_at: event.occurred_at,
      last_received_at: receivedAt,
    },
    pending_event_receipt: receipt,
    revision: run.revision + 1,
    updated_at: receivedAt,
    ...(event.kind === "finished" ? { finished_at: receivedAt } : {}),
  }));
  if (!updated) {
    let winner = await dependencies.get(event.metadata.run_id);
    if (winner) {
      assertReportIdentity(winner, event);
      winner = await flushPendingReceipt(winner, dependencies);
      assertReportIdentity(winner, event);
      const winnerSequence = winner.metadata.last_sequence as number;
      if (winnerSequence > event.sequence) return winner;
      if (
        winnerSequence === event.sequence &&
        winner.metadata.last_event_id === event.event_id &&
        winner.metadata.last_event_hash === incomingHash
      ) {
        return winner;
      }
    }
    throw new PluginJobError(PLUGIN_JOB_ERROR_CODES.CONFLICT, "任务状态已被其他 worker 修改");
  }
  return flushPendingReceipt(updated, dependencies);
}
