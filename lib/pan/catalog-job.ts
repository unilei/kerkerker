/**
 * Provider-neutral identity for the KKPAN catalog synchronization job.
 *
 * This module is intentionally a pure migration boundary.  It describes the
 * generic job that will eventually be owned by PluginJobRunner, while the
 * legacy Pan scheduler remains the only production executor until the
 * cutover handler is implemented and verified.
 */

import type { AuditActorDoc } from "@/lib/compliance-types";
import {
  KKPAN_PLUGIN_ID,
  kkpanCloudDriveManifest,
} from "@/lib/plugins/adapters/kkpan-cloud-drive";
import type {
  PluginJobEnqueueInput,
  PluginJobRun,
  PluginJobRunnerPort,
} from "@/lib/plugins/job-runner";

export const PAN_CATALOG_JOB_ID = "resource.cloud-drive.catalog-sync";
export const PAN_CATALOG_JOB_MODE_ENV = "PAN_SYNC_CATALOG_JOB_MODE";

export const PAN_CATALOG_JOB_MODES = ["off", "shadow", "cutover"] as const;
export type PanCatalogJobMode = (typeof PAN_CATALOG_JOB_MODES)[number];

export interface PanCatalogJobSource {
  readonly runId: string;
  readonly trigger: "scheduled" | "manual";
  readonly batchLimit: number;
  readonly maxBatches: number;
  readonly scheduleSlot?: string;
  readonly pluginId?: string;
  readonly pluginVersion?: string;
  readonly profileId: string;
  readonly profile: string;
  readonly configVersion: string;
  readonly actor: AuditActorDoc;
}

export interface PanCatalogJobProjection {
  readonly mode: Exclude<PanCatalogJobMode, "off">;
  readonly jobId: typeof PAN_CATALOG_JOB_ID;
  readonly runId: string;
  readonly legacyRunId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly profileId: string;
  readonly profile: string;
  readonly configVersion: string;
  readonly actor: AuditActorDoc;
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} 不能为空`);
  }
  return value.trim();
}

/** Read the migration switch without silently accepting misspelled values. */
export function getPanCatalogJobMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): PanCatalogJobMode {
  const value = env[PAN_CATALOG_JOB_MODE_ENV]?.trim().toLowerCase();
  if (!value) return "off";
  if ((PAN_CATALOG_JOB_MODES as readonly string[]).includes(value)) {
    return value as PanCatalogJobMode;
  }
  throw new RangeError(
    `${PAN_CATALOG_JOB_MODE_ENV} 必须是 off、shadow 或 cutover`
  );
}

function logicalWindow(source: PanCatalogJobSource): string {
  return source.scheduleSlot
    ? `schedule:${nonEmpty(source.scheduleSlot, "scheduleSlot")}`
    : `run:${nonEmpty(source.runId, "runId")}`;
}

/**
 * Build the one stable identity used by both the legacy projection and the
 * future host-controlled job.  Scheduled slots are repeat-safe; manual runs
 * intentionally use their unique legacy run ID as the logical window.
 */
export function panCatalogJobIdempotencyKey(
  source: PanCatalogJobSource
): string {
  const pluginId = nonEmpty(source.pluginId || KKPAN_PLUGIN_ID, "pluginId");
  const profileId = nonEmpty(source.profileId, "profileId");
  return `job:${pluginId}:${PAN_CATALOG_JOB_ID}:${profileId}:${logicalWindow(source)}`;
}

/**
 * Describe a catalog run for migration bookkeeping. `shadow` may be persisted
 * as a non-claimable projection, but it cannot become executable until the
 * explicit cutover path promotes it. Keeping the canonical job ID in the
 * projection prevents a second provider-specific vocabulary from becoming
 * permanent.
 */
export function createPanCatalogJobProjection(
  source: PanCatalogJobSource,
  mode: Exclude<PanCatalogJobMode, "off"> = "shadow"
): PanCatalogJobProjection {
  const runId = nonEmpty(source.runId, "runId");
  const pluginId = nonEmpty(source.pluginId || KKPAN_PLUGIN_ID, "pluginId");
  const pluginVersion = nonEmpty(
    source.pluginVersion || kkpanCloudDriveManifest.version,
    "pluginVersion"
  );
  const profileId = nonEmpty(source.profileId, "profileId");
  const profile = nonEmpty(source.profile, "profile");
  const configVersion = nonEmpty(source.configVersion, "configVersion");
  const idempotencyKey = panCatalogJobIdempotencyKey({
    ...source,
    pluginId,
  });

  return {
    mode,
    jobId: PAN_CATALOG_JOB_ID,
    runId: `pan-catalog:${runId}`,
    legacyRunId: runId,
    pluginId,
    pluginVersion,
    profileId,
    profile,
    configVersion,
    actor: { ...source.actor },
    idempotencyKey,
    metadata: {
      source: "pan-scheduler",
      task: "catalog",
      trigger: source.trigger,
      batch_limit: source.batchLimit,
      max_batches: source.maxBatches,
      ...(source.scheduleSlot ? { schedule_slot: source.scheduleSlot } : {}),
      legacy_run_id: runId,
      migration_mode: mode,
      shadow: mode === "shadow",
    },
  };
}

/**
 * Convert a projection to the runner's enqueue shape for the eventual
 * cutover.  The current scheduler deliberately does not call this function
 * to persist a second task; keeping the factory here makes the future write
 * path explicit and testable.
 */
export function toPanCatalogJobEnqueueInput(
  projection: PanCatalogJobProjection
): PluginJobEnqueueInput {
  if (projection.mode !== "cutover") {
    throw new Error("只有 cutover 目录任务才能进入宿主任务队列");
  }
  return toEnqueueInput(projection, true);
}

/** Build a durable but explicitly non-claimable shadow projection. */
export function toPanCatalogJobShadowEnqueueInput(
  projection: PanCatalogJobProjection
): PluginJobEnqueueInput {
  if (projection.mode !== "shadow") {
    throw new Error("只有 shadow 目录任务才能创建影子投影");
  }
  return toEnqueueInput(projection, false);
}

function toEnqueueInput(
  projection: PanCatalogJobProjection,
  hostClaimable: boolean
): PluginJobEnqueueInput {
  return {
    runId: projection.runId,
    jobId: projection.jobId,
    controlMode: "host",
    ...(hostClaimable ? {} : { hostClaimable: false }),
    pluginId: projection.pluginId,
    pluginVersion: projection.pluginVersion,
    profileId: projection.profileId,
    profile: projection.profile,
    configVersion: projection.configVersion,
    actor: { ...projection.actor },
    idempotencyKey: projection.idempotencyKey,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    metadata: { ...projection.metadata },
  };
}

/**
 * Persist the migration projection in the generic job store.  `off` is a
 * no-op; `shadow` writes a non-claimable host-shaped record; `cutover` writes
 * a claimable record for the future executor.  The caller decides whether a
 * projection failure is fatal to the legacy run.
 */
export async function enqueuePanCatalogJobProjection(
  runner: PluginJobRunnerPort,
  source: PanCatalogJobSource,
  mode: PanCatalogJobMode
): Promise<PluginJobRun | null> {
  if (mode === "off") return null;
  const projection = createPanCatalogJobProjection(source, mode);
  const input = mode === "shadow"
    ? toPanCatalogJobShadowEnqueueInput(projection)
    : toPanCatalogJobEnqueueInput(projection);
  return runner.enqueue(input);
}
