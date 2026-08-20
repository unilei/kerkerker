import { randomUUID } from "node:crypto";
import type { Document, ObjectId } from "mongodb";
import { getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import {
  acquirePanSyncLease,
  getPanSyncState,
  releasePanSyncLease,
  renewPanSyncLease,
} from "@/lib/pan-resources-db";
import {
  discoverAndEnqueuePanSyncTargets,
  getPanSyncTargetStats,
  queueDuePanSyncTargets,
  runPanSyncTargetBatch,
  type PanSyncTarget,
} from "@/lib/pan/catalog-sync";
import { runIncrementalSync, type SyncStats } from "@/lib/pan/sync";

export const PAN_SYNC_TASKS = ["catalog", "incremental"] as const;
export type PanSyncTask = (typeof PAN_SYNC_TASKS)[number];

export const PAN_SYNC_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;
export type PanSyncRunStatus = (typeof PAN_SYNC_RUN_STATUSES)[number];
export type PanSyncRunTrigger = "scheduled" | "manual";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_SCHEDULES: Record<PanSyncTask, { hour: number; minute: number }> = {
  catalog: { hour: 3, minute: 0 },
  incremental: { hour: 3, minute: 30 },
};
const DEFAULT_BATCH_LIMIT: Record<PanSyncTask, number> = {
  catalog: 5,
  incremental: 50,
};
const DEFAULT_MAX_BATCHES: Record<PanSyncTask, number> = {
  catalog: 100,
  incremental: 1,
};
const RUN_LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SCHEDULER_TICK_MS = 30 * 1000;
const STALE_RUN_MS = 7 * 60 * 1000;
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// 定时槽位认领与运行记录写入不是同一个 Mongo 操作。认领超过这个窗口仍
// 没有对应 run 时，下一轮调度会把它视为进程崩溃留下的孤儿槽位并释放。
const SCHEDULE_CLAIM_GRACE_MS = RUN_LEASE_TTL_MS;

export interface PanSyncScheduleDoc {
  _id?: ObjectId;
  task: PanSyncTask;
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: string;
  batch_limit: number;
  max_batches: number;
  last_scheduled_date?: string;
  next_run_at?: string;
  scheduled_claim_owner?: string;
  scheduled_claimed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PanSyncSchedule {
  task: PanSyncTask;
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: string;
  batch_limit: number;
  max_batches: number;
  last_scheduled_date?: string;
  next_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PanSyncRunDoc {
  _id?: ObjectId;
  run_id: string;
  task: PanSyncTask;
  trigger: PanSyncRunTrigger;
  status: PanSyncRunStatus;
  batch_limit: number;
  max_batches: number;
  schedule_slot?: string;
  discovered: number;
  queued: number;
  processed: number;
  synced: number;
  empty: number;
  failed: number;
  imported: number;
  refreshed: number;
  disabled: number;
  remaining: number;
  progress_total: number;
  completed_batches: number;
  current_douban_id?: string;
  current_title?: string;
  last_error?: string;
  cancel_requested: boolean;
  event_seq: number;
  owner?: string;
  heartbeat_at?: string;
  recovery_logged_at?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
  expires_at: Date;
}

export interface PanSyncRun {
  run_id: string;
  task: PanSyncTask;
  trigger: PanSyncRunTrigger;
  status: PanSyncRunStatus;
  batch_limit: number;
  max_batches: number;
  discovered: number;
  queued: number;
  processed: number;
  synced: number;
  empty: number;
  failed: number;
  imported: number;
  refreshed: number;
  disabled: number;
  remaining: number;
  progress_total: number;
  completed_batches: number;
  current_douban_id?: string;
  current_title?: string;
  last_error?: string;
  cancel_requested: boolean;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PanSyncRunEvent extends Document {
  run_id: string;
  seq: number;
  level: "info" | "warning" | "error";
  message: string;
  data?: Record<string, unknown>;
  created_at: string;
  expires_at: Date;
}

export class PanSyncSchedulerBusyError extends Error {
  constructor() {
    super("已有同步任务正在执行");
    this.name = "PanSyncSchedulerBusyError";
  }
}

function taskCollection<T extends Document>(name: string) {
  return getDatabase().then((db) => db.collection<T>(name));
}

function scheduleCollection() {
  return taskCollection<PanSyncScheduleDoc>(COLLECTIONS.PAN_SYNC_SCHEDULE);
}

function runCollection() {
  return taskCollection<PanSyncRunDoc>(COLLECTIONS.PAN_SYNC_RUNS);
}

function eventCollection() {
  return taskCollection<PanSyncRunEvent>(COLLECTIONS.PAN_SYNC_RUN_EVENTS);
}

function toSchedule(doc: PanSyncScheduleDoc): PanSyncSchedule {
  return {
    task: doc.task,
    enabled: Boolean(doc.enabled),
    hour: doc.hour,
    minute: doc.minute,
    timezone: doc.timezone,
    batch_limit: doc.batch_limit,
    max_batches: doc.max_batches,
    last_scheduled_date: doc.last_scheduled_date,
    next_run_at: doc.next_run_at,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function toRun(doc: PanSyncRunDoc): PanSyncRun {
  return {
    run_id: doc.run_id,
    task: doc.task,
    trigger: doc.trigger,
    status: doc.status,
    batch_limit: doc.batch_limit,
    max_batches: doc.max_batches,
    discovered: doc.discovered || 0,
    queued: doc.queued || 0,
    processed: doc.processed || 0,
    synced: doc.synced || 0,
    empty: doc.empty || 0,
    failed: doc.failed || 0,
    imported: doc.imported || 0,
    refreshed: doc.refreshed || 0,
    disabled: doc.disabled || 0,
    remaining: doc.remaining || 0,
    progress_total: doc.progress_total || 0,
    completed_batches: doc.completed_batches || 0,
    current_douban_id: doc.current_douban_id,
    current_title: doc.current_title,
    last_error: doc.last_error,
    cancel_requested: Boolean(doc.cancel_requested),
    started_at: doc.started_at,
    finished_at: doc.finished_at,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function truncateError(error: unknown, max = 1500): string {
  const value = error instanceof Error ? error.message : String(error || "未知错误");
  return value.slice(0, max);
}

function validateTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function localParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function calculateNextPanSyncRunAt(schedule: Pick<PanSyncSchedule, "hour" | "minute" | "timezone" | "enabled">, now = new Date()): string | undefined {
  if (!schedule.enabled) return undefined;
  // Searching a bounded UTC window handles DST transitions without a home-grown
  // timezone offset table. This runs only when a schedule is saved or displayed.
  for (let offset = 1; offset <= 72 * 60; offset++) {
    const candidate = new Date(now.getTime() + offset * 60_000);
    const parts = localParts(candidate, schedule.timezone);
    if (parts.hour === schedule.hour && parts.minute === schedule.minute) {
      return candidate.toISOString();
    }
  }
  return undefined;
}

export function isPanSyncScheduleDue(schedule: PanSyncSchedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  if (schedule.next_run_at) {
    const next = Date.parse(schedule.next_run_at);
    return Number.isFinite(next) && next <= now.getTime();
  }
  const parts = localParts(now, schedule.timezone);
  if (schedule.last_scheduled_date === parts.date) return false;
  return (
    parts.hour > schedule.hour ||
    (parts.hour === schedule.hour && parts.minute >= schedule.minute)
  );
}

export function defaultPanSyncSchedule(task: PanSyncTask): PanSyncSchedule {
  const now = new Date().toISOString();
  const time = DEFAULT_SCHEDULES[task];
  return {
    task,
    enabled: false,
    hour: time.hour,
    minute: time.minute,
    timezone: DEFAULT_TIMEZONE,
    batch_limit: DEFAULT_BATCH_LIMIT[task],
    max_batches: DEFAULT_MAX_BATCHES[task],
    created_at: now,
    updated_at: now,
  };
}

export async function getPanSyncSchedule(task: PanSyncTask): Promise<PanSyncSchedule> {
  const coll = await scheduleCollection();
  const defaults = defaultPanSyncSchedule(task);
  let doc: PanSyncScheduleDoc | null;
  try {
    doc = await coll.findOneAndUpdate(
      { task },
      { $setOnInsert: defaults },
      { upsert: true, returnDocument: "after" }
    );
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    doc = await coll.findOne({ task });
  }
  // 早期版本允许 incremental 使用多个批次；读到旧文档时立即归一化，
  // 避免后台 UI 把旧值带回后触发 400，也让运行记录与实际语义一致。
  if (doc && task === "incremental" && doc.max_batches !== 1) {
    const normalized = await coll.findOneAndUpdate(
      { task },
      { $set: { max_batches: 1, updated_at: new Date().toISOString() } },
      { returnDocument: "after" }
    );
    doc = normalized || doc;
  }
  return toSchedule(doc || (defaults as PanSyncScheduleDoc));
}

export async function getPanSyncSchedules(): Promise<PanSyncSchedule[]> {
  return Promise.all(PAN_SYNC_TASKS.map((task) => getPanSyncSchedule(task)));
}

export interface PanSyncSchedulePatch {
  enabled?: boolean;
  hour?: number;
  minute?: number;
  timezone?: string;
  batch_limit?: number;
  max_batches?: number;
}

export async function updatePanSyncSchedule(
  task: PanSyncTask,
  patch: PanSyncSchedulePatch
): Promise<PanSyncSchedule> {
  const current = await getPanSyncSchedule(task);
  const next = {
    ...current,
    ...patch,
  };
  if (!Number.isInteger(next.hour) || next.hour < 0 || next.hour > 23) {
    throw new RangeError("hour 必须是 0 到 23 的整数");
  }
  if (!Number.isInteger(next.minute) || next.minute < 0 || next.minute > 59) {
    throw new RangeError("minute 必须是 0 到 59 的整数");
  }
  if (!validateTimezone(next.timezone)) throw new RangeError("timezone 不是有效的时区");
  const maxLimit = task === "incremental" ? 500 : 20;
  if (!Number.isInteger(next.batch_limit) || next.batch_limit < 1 || next.batch_limit > maxLimit) {
    throw new RangeError(`batch_limit 必须是 1 到 ${maxLimit} 的整数`);
  }
  if (!Number.isInteger(next.max_batches) || next.max_batches < 1 || next.max_batches > 1000) {
    throw new RangeError("max_batches 必须是 1 到 1000 的整数");
  }
  if (task === "incremental" && next.max_batches !== 1) {
    throw new RangeError("incremental 任务的 max_batches 固定为 1");
  }
  const now = new Date().toISOString();
  const editable = {
    enabled: Boolean(next.enabled),
    hour: next.hour,
    minute: next.minute,
    timezone: next.timezone,
    batch_limit: next.batch_limit,
    max_batches: next.max_batches,
    updated_at: now,
  };
  const coll = await scheduleCollection();
  let clearUncommittedSlot = false;
  if (!next.enabled && current.last_scheduled_date) {
    const scheduledRun = await (await runCollection()).findOne(
      {
        task,
        schedule_slot: `${task}:${current.last_scheduled_date}`,
      },
      { projection: { _id: 1 } }
    );
    // 禁用发生在 claim 与 run insert 之间时，不要把孤儿日期带到下一次
    // 启用；已经存在运行记录的日期则保留，避免人工切换造成重复执行。
    clearUncommittedSlot = !scheduledRun;
  }
  const unsetWhenDisabled: Record<string, ""> = {
    next_run_at: "",
    scheduled_claim_owner: "",
    scheduled_claimed_at: "",
    ...(clearUncommittedSlot ? { last_scheduled_date: "" } : {}),
  };
  const nextRunAt = next.enabled
    ? calculateNextPanSyncRunAt(next, new Date())
    : undefined;
  const updated = await coll.findOneAndUpdate(
    { task },
    {
      $set: {
        ...editable,
        ...(nextRunAt ? { next_run_at: nextRunAt } : {}),
      },
      ...(!next.enabled || !nextRunAt
        ? { $unset: next.enabled ? { next_run_at: "" } : unsetWhenDisabled }
        : {}),
      $setOnInsert: { task, created_at: current.created_at || now },
    },
    { upsert: true, returnDocument: "after" }
  );
  return toSchedule(updated as PanSyncScheduleDoc);
}

async function claimScheduledSlot(
  task: PanSyncTask,
  date: string,
  nextAt: string | undefined,
  owner: string
): Promise<boolean> {
  const coll = await scheduleCollection();
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    $set: {
      last_scheduled_date: date,
      ...(nextAt ? { next_run_at: nextAt } : {}),
      scheduled_claim_owner: owner,
      scheduled_claimed_at: now,
      updated_at: now,
    },
    ...(!nextAt ? { $unset: { next_run_at: "" } } : {}),
  };
  const result = await coll.updateOne(
    {
      task,
      enabled: true,
      $or: [
        { last_scheduled_date: { $exists: false } },
        { last_scheduled_date: { $ne: date } },
      ],
      // A previous process may have died after claiming the slot. Do not let
      // a fresh scheduler steal a live claim, but allow recovery after the
      // bounded grace period.
      $and: [
        {
          $or: [
            { scheduled_claimed_at: { $exists: false } },
            {
              scheduled_claimed_at: {
                $lte: new Date(Date.now() - SCHEDULE_CLAIM_GRACE_MS).toISOString(),
              },
            },
            { scheduled_claim_owner: owner },
          ],
        },
      ],
    },
    update as never
  );
  return result.modifiedCount === 1;
}

async function releaseScheduledSlot(
  task: PanSyncTask,
  date: string,
  owner?: string
): Promise<void> {
  const filter: Record<string, unknown> = {
    task,
    last_scheduled_date: date,
    ...(owner ? { scheduled_claim_owner: owner } : {}),
  };
  await (await scheduleCollection()).updateOne(
    filter,
    {
      $unset: {
        last_scheduled_date: "",
        next_run_at: "",
        scheduled_claim_owner: "",
        scheduled_claimed_at: "",
      },
      $set: { updated_at: new Date().toISOString() },
    }
  );
}

async function finalizeScheduledSlot(
  task: PanSyncTask,
  date: string,
  owner: string
): Promise<void> {
  await (await scheduleCollection()).updateOne(
    { task, last_scheduled_date: date, scheduled_claim_owner: owner },
    {
      $unset: { scheduled_claim_owner: "", scheduled_claimed_at: "" },
      $set: { updated_at: new Date().toISOString() },
    }
  );
}

async function createRunDoc(input: {
  task: PanSyncTask;
  trigger: PanSyncRunTrigger;
  batchLimit: number;
  maxBatches: number;
  owner: string;
  scheduleSlot?: string;
}): Promise<PanSyncRun> {
  const now = new Date().toISOString();
  const doc: PanSyncRunDoc = {
    run_id: randomUUID(),
    task: input.task,
    trigger: input.trigger,
    status: "queued",
    batch_limit: input.batchLimit,
    max_batches: input.maxBatches,
    ...(input.scheduleSlot ? { schedule_slot: input.scheduleSlot } : {}),
    discovered: 0,
    queued: 0,
    processed: 0,
    synced: 0,
    empty: 0,
    failed: 0,
    imported: 0,
    refreshed: 0,
    disabled: 0,
    remaining: 0,
    progress_total: 0,
    completed_batches: 0,
    cancel_requested: false,
    event_seq: 0,
    owner: input.owner,
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + RUN_RETENTION_MS),
  };
  const coll = await runCollection();
  await coll.insertOne(doc);
  return toRun(doc);
}

async function patchRun(
  runId: string,
  patch: Record<string, unknown>,
  unset: string[] = [],
  owner?: string
) {
  const coll = await runCollection();
  const update: Record<string, unknown> = {
    $set: { ...patch, updated_at: new Date().toISOString() },
  };
  if (unset.length > 0) {
    update.$unset = Object.fromEntries(unset.map((key) => [key, ""]));
  }
  await coll.updateOne(
    { run_id: runId, ...(owner ? { owner, status: "running" } : {}) },
    update as never
  );
}

async function getRunDoc(runId: string): Promise<PanSyncRunDoc | null> {
  const coll = await runCollection();
  return coll.findOne({ run_id: runId });
}

export async function getPanSyncRun(runId: string): Promise<PanSyncRun | null> {
  const doc = await getRunDoc(runId);
  return doc ? toRun(doc) : null;
}

export async function listPanSyncRuns(options: {
  task?: PanSyncTask;
  limit?: number;
} = {}): Promise<PanSyncRun[]> {
  const limit = Math.min(Math.max(Math.floor(options.limit || 20), 1), 100);
  const filter = options.task ? { task: options.task } : {};
  const coll = await runCollection();
  const docs = await coll.find(filter).sort({ created_at: -1 }).limit(limit).toArray();
  return docs.map(toRun);
}

export async function listPanSyncRunEvents(
  runId: string,
  limit = 100
): Promise<PanSyncRunEvent[]> {
  const coll = await eventCollection();
  return coll
    .find({ run_id: runId })
    .sort({ seq: -1 })
    .limit(Math.min(Math.max(Math.floor(limit), 1), 200))
    .toArray()
    .then((events) => events.reverse());
}

async function appendRunEvent(
  runId: string,
  level: PanSyncRunEvent["level"],
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const runs = await runCollection();
  const run = await runs.findOneAndUpdate(
    { run_id: runId },
    { $inc: { event_seq: 1 } },
    { returnDocument: "after", projection: { event_seq: 1 } }
  );
  const seq = run?.event_seq || Date.now();
  const event: PanSyncRunEvent = {
    run_id: runId,
    seq,
    level,
    message: message.slice(0, 1000),
    ...(data ? { data } : {}),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + RUN_RETENTION_MS),
  };
  await (await eventCollection()).insertOne(event);
}

export async function requestPanSyncRunCancel(runId: string): Promise<boolean> {
  const coll = await runCollection();
  const now = new Date().toISOString();
  const queued = await coll.updateOne(
    { run_id: runId, status: "queued", cancel_requested: { $ne: true } },
    {
      $set: {
        cancel_requested: true,
        status: "cancelled",
        finished_at: now,
        updated_at: now,
      },
    }
  );
  if (queued.modifiedCount > 0) {
    await appendRunEvent(runId, "warning", "排队任务已停止");
    return true;
  }
  const running = await coll.updateOne(
    { run_id: runId, status: "running", cancel_requested: { $ne: true } },
    { $set: { cancel_requested: true, updated_at: now } }
  );
  if (running.modifiedCount > 0) {
    await appendRunEvent(runId, "warning", "已请求停止，当前影片完成后退出");
  }
  return running.modifiedCount > 0;
}

async function isRunCancelled(runId: string): Promise<boolean> {
  const doc = await getRunDoc(runId);
  return Boolean(doc?.cancel_requested);
}

async function claimRun(runId: string): Promise<PanSyncRunDoc | null> {
  const coll = await runCollection();
  const now = new Date().toISOString();
  return coll.findOneAndUpdate(
    { run_id: runId, status: "queued", cancel_requested: { $ne: true } },
    { $set: { status: "running", started_at: now, updated_at: now } },
    { returnDocument: "after" }
  );
}

async function touchRunHeartbeat(runId: string, owner: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await (await runCollection()).updateOne(
    { run_id: runId, owner, status: "running" },
    { $set: { heartbeat_at: now, updated_at: now } }
  );
  return result.modifiedCount === 1;
}

async function finishRun(
  runId: string,
  owner: string,
  status: PanSyncRunStatus,
  error?: string
): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    finished_at: new Date().toISOString(),
    ...(error ? { last_error: truncateError(error) } : {}),
  };
  await patchRun(runId, patch, [], owner);
  const level = status === "failed" ? "error" : status === "partial" ? "warning" : "info";
  await appendRunEvent(
    runId,
    level,
    status === "succeeded"
      ? "任务完成"
      : status === "cancelled"
        ? "任务已停止"
        : status === "partial"
          ? "任务完成，但仍有待处理项目或部分失败"
          : "任务失败",
    error ? { error: truncateError(error) } : undefined
  );
}

async function executeCatalogRun(
  runId: string,
  owner: string,
  shouldContinue: () => Promise<boolean>
): Promise<{ status: PanSyncRunStatus; error?: string }> {
  const run = await getRunDoc(runId);
  if (!run) return { status: "failed", error: "运行记录不存在" };
  if (!(await shouldContinue())) return { status: "cancelled" };
  await appendRunEvent(runId, "info", "开始发现站内影片目录");
  const discovery = await discoverAndEnqueuePanSyncTargets({
    runId,
    shouldContinue,
  });
  if (!(await shouldContinue())) return { status: "cancelled" };
  await patchRun(runId, {
    discovered: discovery.discovered,
    queued: discovery.upserted,
    progress_total: discovery.discovered,
  }, [], owner);
  await appendRunEvent(runId, discovery.sourceErrors.length ? "warning" : "info", `目录发现完成：${discovery.discovered} 部影片`, {
    upserted: discovery.upserted,
    source_errors: discovery.sourceErrors,
  });
  if (discovery.discovered === 0 && discovery.sourceErrors.length > 0) {
    return { status: "failed", error: discovery.sourceErrors.join("; ") };
  }

  const due = await queueDuePanSyncTargets();
  if (due > 0) await appendRunEvent(runId, "info", `已重新排入 ${due} 部超过 24 小时未检查的影片`);

  let lastStats = await getPanSyncTargetStats();
  let lastError: string | undefined;
  const discoveryWarning = discovery.sourceErrors.length > 0;
  for (let batch = 0; batch < run.max_batches; batch++) {
    if (!(await shouldContinue())) return { status: "cancelled" };
    const result = await runPanSyncTargetBatch(
      run.batch_limit,
      run.owner || runId,
      undefined,
      {
        shouldContinue,
        onTargetStart: async (target: PanSyncTarget) => {
          await patchRun(runId, {
            current_douban_id: target.douban_id,
            current_title: target.title,
          }, [], owner);
          await appendRunEvent(runId, "info", `开始同步：${target.title}`, {
            douban_id: target.douban_id,
          });
        },
        onTargetComplete: async (target, targetResult) => {
          const before = await getRunDoc(runId);
          const processed = (before?.processed || 0) + 1;
          await patchRun(
            runId,
            {
              processed,
              synced: (before?.synced || 0) + (targetResult.status === "synced" ? 1 : 0),
              empty: (before?.empty || 0) + (targetResult.status === "empty" ? 1 : 0),
              failed: (before?.failed || 0) + (targetResult.status === "failed" ? 1 : 0),
              imported: (before?.imported || 0) + targetResult.imported,
              refreshed: (before?.refreshed || 0) + targetResult.refreshed,
              disabled: (before?.disabled || 0) + targetResult.disabled,
            },
            ["current_douban_id", "current_title"],
            owner
          );
          await appendRunEvent(
            runId,
            targetResult.status === "failed" ? "error" : "info",
            `${targetResult.status === "failed" ? "同步失败" : "同步完成"}：${target.title}`,
            {
              douban_id: target.douban_id,
              status: targetResult.status,
              imported: targetResult.imported,
              error: targetResult.error,
            }
          );
        },
      }
    );
    lastStats = result.stats;
    const before = await getRunDoc(runId);
    await patchRun(runId, {
      remaining: result.remaining,
      progress_total: Math.max(before?.progress_total || 0, (before?.processed || 0) + result.remaining),
      completed_batches: batch + 1,
    }, ["current_douban_id", "current_title"], owner);
    await appendRunEvent(runId, result.failed > 0 ? "warning" : "info", `第 ${batch + 1} 批完成：处理 ${result.processed} 部，剩余 ${result.remaining} 部`, {
      processed: result.processed,
      imported: result.imported,
      failed: result.failed,
      remaining: result.remaining,
    });
    if (result.failed > 0) lastError = `${result.failed} 部影片同步失败`;
    if (result.processed === 0 || result.remaining <= 0) break;
  }
  if (!(await shouldContinue())) return { status: "cancelled" };
  const current = await getRunDoc(runId);
  if (lastStats.failed || current?.failed) {
    return { status: current?.processed ? "partial" : "failed", error: lastError || "部分影片同步失败" };
  }
  if ((current?.remaining || lastStats.pending || 0) > 0) {
    return { status: "partial", error: "达到本次任务批次上限，仍有影片待同步" };
  }
  if (discoveryWarning) {
    return { status: "partial", error: `目录发现有 ${discovery.sourceErrors.length} 个来源失败，结果可能不完整` };
  }
  return { status: "succeeded" };
}

async function executeIncrementalRun(
  runId: string,
  owner: string,
  shouldContinue: () => Promise<boolean>
): Promise<{ status: PanSyncRunStatus; error?: string }> {
  const run = await getRunDoc(runId);
  if (!run) return { status: "failed", error: "运行记录不存在" };
  if (!(await shouldContinue())) return { status: "cancelled" };
  await appendRunEvent(runId, "info", "开始执行 kkpans 增量同步", { limit: run.batch_limit });
  const stats: SyncStats = await runIncrementalSync(
    run.batch_limit,
    true,
    shouldContinue,
    { runId }
  );
  const cancelled = Boolean(stats.cancelled) || !(await shouldContinue());
  await patchRun(runId, {
    discovered: stats.pulled,
    queued: stats.pulled,
    progress_total: stats.pulled,
    processed: stats.pulled,
    synced: stats.imported,
    empty: stats.unmatched,
    failed: stats.failed ? 1 : 0,
    imported: stats.imported,
    refreshed: stats.refreshed || 0,
    disabled: stats.disabled,
    remaining: 0,
    completed_batches: 1,
  }, [], owner);
  await appendRunEvent(
    runId,
    cancelled ? "warning" : stats.failed ? "error" : stats.sourceErrors ? "warning" : "info",
    cancelled ? "增量同步已停止" : stats.failed ? "增量同步失败" : "增量同步完成",
    {
    pulled: stats.pulled,
    imported: stats.imported,
    disabled: stats.disabled,
    refreshed: stats.refreshed || 0,
    source_errors: stats.sourceErrors || 0,
    duration_ms: stats.durationMs,
    }
  );
  if (cancelled) return { status: "cancelled" };
  return stats.cancelled
    ? { status: "cancelled" }
    : stats.failed
    ? { status: "failed", error: "上游服务不可用，本次增量同步未确认" }
    : stats.sourceErrors
      ? { status: "partial", error: "增量同步完成，但上游有部分错误" }
      : { status: "succeeded" };
}

const globalScheduler = globalThis as unknown as {
  panSyncSchedulerStarted?: boolean;
  panSyncSchedulerTimer?: ReturnType<typeof setTimeout>;
  panSyncActiveRuns?: Map<string, Promise<void>>;
  panSyncLastRecoveryAt?: number;
};

function activeRuns() {
  if (!globalScheduler.panSyncActiveRuns) globalScheduler.panSyncActiveRuns = new Map();
  return globalScheduler.panSyncActiveRuns;
}

function schedulerPollMs(): number {
  const parsed = Number(process.env.PAN_SYNC_SCHEDULER_POLL_MS || DEFAULT_SCHEDULER_TICK_MS);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_SCHEDULER_TICK_MS;
  return Math.min(Math.max(parsed, 10_000), 10 * 60 * 1000);
}

async function executeRun(runId: string, owner: string): Promise<void> {
  let leaseLost = false;
  let claimed = false;
  const heartbeat = setInterval(() => {
    void renewPanSyncLease(owner, RUN_LEASE_TTL_MS)
      .then(async (renewed) => {
        if (!renewed) {
          leaseLost = true;
          return;
        }
        if (claimed && !(await touchRunHeartbeat(runId, owner))) {
          leaseLost = true;
        }
      })
      .catch((error) => {
        leaseLost = true;
        console.error("续租后台同步租约失败:", error);
      });
  }, 30_000);
  heartbeat.unref?.();
  try {
    const run = await claimRun(runId);
    if (!run) return;
    claimed = true;
    await appendRunEvent(runId, "info", `任务开始（${run.trigger === "scheduled" ? "定时" : "手动"}）`);
    const shouldContinue = async () =>
      !leaseLost && !(await isRunCancelled(runId));
    const result = run.task === "catalog"
      ? await executeCatalogRun(runId, owner, shouldContinue)
      : await executeIncrementalRun(runId, owner, shouldContinue);
    await finishRun(
      runId,
      owner,
      leaseLost ? "failed" : result.status,
      leaseLost ? "同步租约已失效，本次任务结果未确认" : result.error
    );
  } catch (error) {
    const message = truncateError(error);
    await patchRun(runId, { last_error: message }, [], owner).catch(() => undefined);
    await finishRun(runId, owner, "failed", message).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    await releasePanSyncLease(owner).catch((error) => {
      console.error("释放后台同步租约失败:", error);
    });
    activeRuns().delete(runId);
  }
}

function launchRun(runId: string, owner: string): void {
  const promise = executeRun(runId, owner).catch((error) => {
    console.error("后台同步任务异常:", error);
  });
  activeRuns().set(runId, promise);
}

export async function enqueuePanSyncRun(options: {
  task: PanSyncTask;
  trigger?: PanSyncRunTrigger;
  batchLimit?: number;
  maxBatches?: number;
}): Promise<PanSyncRun> {
  const schedule = await getPanSyncSchedule(options.task);
  const batchLimit = options.batchLimit ?? schedule.batch_limit;
  const maxBatches = options.maxBatches ?? schedule.max_batches;
  const maxLimit = options.task === "incremental" ? 500 : 20;
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > maxLimit) {
    throw new RangeError(`batch_limit 必须是 1 到 ${maxLimit} 的整数`);
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000) {
    throw new RangeError("max_batches 必须是 1 到 1000 的整数");
  }
  if (options.task === "incremental" && maxBatches !== 1) {
    throw new RangeError("incremental 任务的 max_batches 固定为 1");
  }
  const owner = `pan-scheduler-${randomUUID()}`;
  if (!(await acquirePanSyncLease(owner, RUN_LEASE_TTL_MS))) {
    throw new PanSyncSchedulerBusyError();
  }
  try {
    const run = await createRunDoc({
      task: options.task,
      trigger: options.trigger || "manual",
      batchLimit,
      maxBatches,
      owner,
    });
    launchRun(run.run_id, owner);
    return run;
  } catch (error) {
    await releasePanSyncLease(owner).catch(() => undefined);
    throw error;
  }
}

async function recoverStaleRuns(): Promise<void> {
  const coll = await runCollection();
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();
  const recoveryAt = new Date().toISOString();
  const syncState = await getPanSyncState();
  const lease = syncState?.sync_lease;
  const liveOwner =
    lease && Date.parse(lease.expires_at) > Date.now() ? lease.owner : undefined;
  const result = await coll.updateMany(
    {
      status: { $in: ["queued", "running"] },
      updated_at: { $lt: cutoff },
      ...(liveOwner ? { owner: { $ne: liveOwner } } : {}),
      $or: [
        { heartbeat_at: { $exists: false } },
        { heartbeat_at: { $lt: cutoff } },
      ],
    },
    {
      $set: {
        status: "failed",
        last_error: "应用重启后任务未能恢复，请手动重试",
        finished_at: new Date().toISOString(),
        recovery_logged_at: recoveryAt,
        updated_at: new Date().toISOString(),
      },
    }
  );
  if (result.modifiedCount > 0) {
    console.warn(`已标记 ${result.modifiedCount} 个失联的后台同步任务`);
    // 事件写入是 best-effort；运行状态已经落库，不能因日志故障阻塞调度器。
    const staleRuns = await coll
      .find({ status: "failed", recovery_logged_at: recoveryAt })
      .project({ run_id: 1 })
      .toArray();
    await Promise.all(
      staleRuns.map((run) => appendRunEvent(String(run.run_id), "error", "任务被恢复检查标记为失败"))
    );
  }
}

/**
 * 补偿 schedulerTick 在“占用日期槽位”后进程退出的窗口。
 *
 * 槽位认领和 run insert 无法在当前部署的 Mongo 单节点配置中依赖事务，
 * 所以认领会留下 owner/time。超过租约宽限期仍找不到对应 schedule_slot
 * 的运行记录时，释放槽位让当天的下一轮 tick 可以重试；如果 run 已经写入，
 * 只清理认领标记，不会重复创建任务。
 */
async function repairOrphanedScheduledSlots(): Promise<void> {
  const schedules = await (await scheduleCollection())
    .find({ last_scheduled_date: { $exists: true } })
    .toArray();
  if (schedules.length === 0) return;
  const runs = await runCollection();
  const now = Date.now();
  for (const schedule of schedules) {
    if (!schedule.last_scheduled_date) continue;
    const slot = `${schedule.task}:${schedule.last_scheduled_date}`;
    const run = await runs.findOne(
      { task: schedule.task, schedule_slot: slot },
      { projection: { _id: 1 } }
    );
    if (run) {
      if (schedule.scheduled_claim_owner) {
        await (await scheduleCollection()).updateOne(
          {
            task: schedule.task,
            last_scheduled_date: schedule.last_scheduled_date,
            scheduled_claim_owner: schedule.scheduled_claim_owner,
          },
          {
            $unset: { scheduled_claim_owner: "", scheduled_claimed_at: "" },
            $set: { updated_at: new Date().toISOString() },
          }
        );
      }
      continue;
    }

    const claimedAt = Date.parse(
      schedule.scheduled_claimed_at || schedule.updated_at || ""
    );
    if (!Number.isFinite(claimedAt) || now - claimedAt < SCHEDULE_CLAIM_GRACE_MS) {
      continue;
    }
    await releaseScheduledSlot(
      schedule.task,
      schedule.last_scheduled_date,
      schedule.scheduled_claim_owner
    );
    console.warn(`已释放无运行记录的 ${slot} 定时槽位，将在本轮重新调度`);
  }
}

// 进程可能在 createRunDoc 成功后、launchRun 执行前退出。租约过期后把这条
// queued 记录转交给新的 owner，避免后台只留下“排队中”而永远不执行。
async function resumeQueuedRun(): Promise<void> {
  const coll = await runCollection();
  const queued = await coll
    .findOne(
      { status: "queued", cancel_requested: { $ne: true } },
      { sort: { created_at: 1 } }
    );
  if (!queued) return;
  const owner = `pan-resume-${randomUUID()}`;
  if (!(await acquirePanSyncLease(owner, RUN_LEASE_TTL_MS))) return;
  const claimed = await coll.findOneAndUpdate(
    { run_id: queued.run_id, status: "queued", cancel_requested: { $ne: true } },
    { $set: { owner, updated_at: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!claimed) {
    await releasePanSyncLease(owner).catch(() => undefined);
    return;
  }
  launchRun(claimed.run_id, owner);
  console.log(`已恢复排队中的 ${claimed.task} 同步任务：${claimed.run_id}`);
}

async function schedulerTick(): Promise<void> {
  if (
    process.env.PAN_SYNC_SCHEDULER_DISABLED === "true" ||
    process.env.PAN_SYNC_SCHEDULER_ENABLED === "false" ||
    !process.env.MONGODB_URI
  ) return;
  try {
    const now = new Date();
    if (!globalScheduler.panSyncLastRecoveryAt || Date.now() - globalScheduler.panSyncLastRecoveryAt > 5 * 60 * 1000) {
      await recoverStaleRuns();
      globalScheduler.panSyncLastRecoveryAt = Date.now();
    }
    await repairOrphanedScheduledSlots();
    await resumeQueuedRun();
    for (const task of PAN_SYNC_TASKS) {
      const schedule = await getPanSyncSchedule(task);
      if (!isPanSyncScheduleDue(schedule, now)) continue;
      const parts = localParts(now, schedule.timezone);
      const owner = `pan-scheduled-${task}-${randomUUID()}`;
      if (!(await acquirePanSyncLease(owner, RUN_LEASE_TTL_MS))) continue;
      const claimed = await claimScheduledSlot(
        task,
        parts.date,
        calculateNextPanSyncRunAt(schedule, now),
        owner
      );
      if (!claimed) {
        await releasePanSyncLease(owner).catch(() => undefined);
        continue;
      }
      try {
        const run = await createRunDoc({
          task,
          trigger: "scheduled",
          batchLimit: schedule.batch_limit,
          maxBatches: schedule.max_batches,
          owner,
          scheduleSlot: `${task}:${parts.date}`,
        });
        launchRun(run.run_id, owner);
        // 启动本地执行后再清理认领标记。若进程恰好在两步之间退出，
        // run 已经存在，下一轮 repair 会安全地完成清理而不会重复创建。
        await finalizeScheduledSlot(task, parts.date, owner);
        console.log(`已启动 ${task} 定时同步任务：${run.run_id}`);
      } catch (error) {
        await releaseScheduledSlot(task, parts.date, owner).catch(() => undefined);
        await releasePanSyncLease(owner).catch(() => undefined);
        console.error("创建定时同步任务失败:", error);
      }
    }
  } catch (error) {
    console.error("后台同步调度器检查失败:", error);
  }
}

export function startPanSyncScheduler(): void {
  if (globalScheduler.panSyncSchedulerStarted) return;
  globalScheduler.panSyncSchedulerStarted = true;
  const tick = () => {
    void schedulerTick().finally(() => {
      globalScheduler.panSyncSchedulerTimer = setTimeout(tick, schedulerPollMs());
      globalScheduler.panSyncSchedulerTimer.unref?.();
    });
  };
  globalScheduler.panSyncSchedulerTimer = setTimeout(tick, 15_000);
  globalScheduler.panSyncSchedulerTimer.unref?.();
  console.log("✅ 影片网盘后台调度器已启动");
}

export async function getPanSyncSchedulerDashboard(options: {
  task?: PanSyncTask;
  runId?: string;
  limit?: number;
} = {}) {
  const schedules = options.task
    ? [await getPanSyncSchedule(options.task)]
    : await getPanSyncSchedules();
  const runs = await listPanSyncRuns({ task: options.task, limit: options.limit || 20 });
  const selected = options.runId
    ? await getPanSyncRun(options.runId)
    : runs.find((run) => run.status === "queued" || run.status === "running") || runs[0] || null;
  const events = selected ? await listPanSyncRunEvents(selected.run_id, 100) : [];
  return { schedules, runs, active_run: selected, events };
}

export async function ensurePanSyncSchedulerIndexes(): Promise<void> {
  const db = await getDatabase();
  await db.collection(COLLECTIONS.PAN_SYNC_SCHEDULE).createIndex({ task: 1 }, { unique: true });
  const runs = db.collection(COLLECTIONS.PAN_SYNC_RUNS);
  await runs.createIndex({ run_id: 1 }, { unique: true });
  await runs.createIndex(
    { task: 1, schedule_slot: 1 },
    { unique: true, partialFilterExpression: { schedule_slot: { $type: "string" } } }
  );
  await runs.createIndex({ task: 1, created_at: -1 });
  await runs.createIndex({ status: 1, updated_at: -1 });
  await runs.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  const events = db.collection(COLLECTIONS.PAN_SYNC_RUN_EVENTS);
  await events.createIndex({ run_id: 1, seq: 1 }, { unique: true });
  await events.createIndex({ run_id: 1, created_at: 1 });
  await events.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
}
