/**
 * Host handler for the provider-neutral KKPAN catalog job.
 *
 * The registration is intentionally inert until a caller starts
 * `PluginHostExecutor` with the registry.  During migration the legacy Pan
 * scheduler remains the only production executor; this module makes the
 * eventual cutover path explicit and testable.
 */

import {
  discoverAndEnqueuePanSyncTargets,
  queueDuePanSyncTargets,
  runPanSyncTargetBatch,
  type PanSyncTargetBatchResult,
  type PanSyncTargetStats,
} from "@/lib/pan/catalog-sync";
import { PAN_CATALOG_JOB_ID } from "@/lib/pan/catalog-job";
import {
  KKPAN_PLUGIN_ID,
  kkpanCloudDriveManifest,
} from "@/lib/plugins/adapters/kkpan-cloud-drive";
import {
  createPluginJobHandlerRegistry,
  type PluginJobExecutionContext,
  type PluginJobHandlerRegistration,
  type PluginJobHandlerResult,
} from "@/lib/plugins/job-executor";
import {
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobErrorSnapshot,
  type PluginJobStatus,
} from "@/lib/plugins/job-runner";
import { redactPluginJobEventText } from "@/lib/plugins/job-events";
import {
  type PanCatalogLegacyProjectionInput,
  syncPanCatalogLegacyProjection,
} from "@/lib/pan/catalog-job-bridge";

/** Alias retained for callers that used the pre-contract handler name. */
export const PAN_CATALOG_HOST_HANDLER_ID = PAN_CATALOG_JOB_ID;

const MAX_BATCH_LIMIT = 20;
const MAX_BATCHES = 1_000;

export interface PanCatalogHostHandlerDependencies {
  discoverAndEnqueue: typeof discoverAndEnqueuePanSyncTargets;
  queueDue: typeof queueDuePanSyncTargets;
  runBatch: typeof runPanSyncTargetBatch;
  /** Optional because a completed batch already contains authoritative stats. */
  getStats?: () => Promise<PanSyncTargetStats>;
  /** Optional compatibility write, enabled only by the production cutover registry. */
  syncLegacyProjection?: (
    input: PanCatalogLegacyProjectionInput
  ) => Promise<boolean | void>;
}

export interface PanCatalogHostHandlerOptions {
  readonly dependencies?: Partial<PanCatalogHostHandlerDependencies>;
  /** Enable Mongo compatibility writes for the production cutover registry. */
  readonly production?: boolean;
}

/** Narrow return type for direct callers; registration accepts this handler. */
export type PanCatalogHostHandler = (
  context: PluginJobExecutionContext
) => Promise<PluginJobHandlerResult>;

const defaultDependencies: PanCatalogHostHandlerDependencies = {
  discoverAndEnqueue: discoverAndEnqueuePanSyncTargets,
  queueDue: queueDuePanSyncTargets,
  runBatch: runPanSyncTargetBatch,
};

function dependencySet(
  dependencies: Partial<PanCatalogHostHandlerDependencies> | undefined
): PanCatalogHostHandlerDependencies {
  return {
    ...defaultDependencies,
    ...(dependencies || {}),
  };
}

function boundedMetadataInteger(
  value: unknown,
  field: string,
  fallback: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${field} 元数据无效`);
  }
  return value;
}

function encodeCursor(input: {
  batch: number;
  lastTargetId?: string;
  remaining: number;
  imported?: number;
  refreshed?: number;
  disabled?: number;
}): string {
  return JSON.stringify({
    version: 1,
    batch: input.batch,
    ...(input.lastTargetId ? { last_target_id: input.lastTargetId } : {}),
    remaining: input.remaining,
    ...(input.imported !== undefined ? { imported: input.imported } : {}),
    ...(input.refreshed !== undefined ? { refreshed: input.refreshed } : {}),
    ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
  });
}

function errorResult(code: string, message: string): PluginJobHandlerResult {
  const safeMessage = redactPluginJobEventText(message).slice(0, 1500);
  return {
    status: "failed",
    error: { code, message: safeMessage, retryable: false },
  };
}

function isLeaseLoss(error: unknown): boolean {
  return (
    error instanceof PluginJobError &&
    error.code === PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED
  );
}

async function isCancelled(context: PluginJobExecutionContext): Promise<boolean> {
  if (context.signal.aborted) return true;
  return context.isCancellationRequested();
}

async function syncLegacy(
  dependencies: PanCatalogHostHandlerDependencies,
  context: PluginJobExecutionContext,
  status?: PluginJobStatus,
  error?: PluginJobErrorSnapshot
): Promise<void> {
  if (!dependencies.syncLegacyProjection) return;
  try {
    await dependencies.syncLegacyProjection({
      legacyRunId:
        typeof context.run.metadata.legacy_run_id === "string"
          ? context.run.metadata.legacy_run_id
          : context.run.run_id.replace(/^pan-catalog:/, ""),
      run: context.run,
      ...(status ? { status } : {}),
      ...(error ? { error } : {}),
    });
  } catch (syncError) {
    // The generic snapshot is authoritative. A failed compatibility write is
    // retried by a later reconciliation pass and must not fail the real job.
    console.warn(
      "KKPAN 目录兼容投影回写失败:",
      redactPluginJobEventText(
        syncError instanceof Error ? syncError.message : String(syncError)
      )
    );
  }
}

function progressDelta(result: PanSyncTargetBatchResult): {
  created: number;
  failed: number;
  skipped: number;
} {
  // The generic contract categorises *targets*, while `imported` is a count
  // of resource rows and may be greater than the number of processed targets.
  // Use target-level `synced` and reconcile malformed provider counts so the
  // invariant created + failed + skipped === processed always holds.
  const processed = Math.max(0, Math.floor(result.processed || 0));
  const failed = Math.min(
    processed,
    Math.max(0, Math.floor(result.failed || 0))
  );
  const created = Math.min(
    processed - failed,
    Math.max(0, Math.floor(result.synced || 0))
  );
  return {
    created,
    failed,
    skipped: processed - created - failed,
  };
}

/**
 * Create the KKPAN catalog handler with injectable storage functions.  The
 * injection point keeps the migration contract unit-testable without a live
 * MongoDB or upstream catalog.
 */
export function createPanCatalogHostJobHandler(
  options: PanCatalogHostHandlerOptions = {}
): PanCatalogHostHandler {
  const dependencies = dependencySet({
    ...(options.production
      ? { syncLegacyProjection: syncPanCatalogLegacyProjection }
      : {}),
    ...(options.dependencies || {}),
  });

  return async function executePanCatalogJob(
    context: PluginJobExecutionContext
  ): Promise<PluginJobHandlerResult> {
    const run = context.run;
    const metadata = run.metadata;
    if (
      metadata.source !== "pan-scheduler" ||
      metadata.task !== "catalog" ||
      metadata.migration_mode !== "cutover" ||
      metadata.shadow === true
    ) {
      return errorResult(
        "JOB_MIGRATION_MODE_INVALID",
        "KKPAN 目录宿主任务缺少 cutover 迁移标记"
      );
    }

    let batchLimit: number;
    let maxBatches: number;
    try {
      batchLimit = boundedMetadataInteger(
        metadata.batch_limit,
        "batch_limit",
        5,
        MAX_BATCH_LIMIT
      );
      maxBatches = boundedMetadataInteger(
        metadata.max_batches,
        "max_batches",
        100,
        MAX_BATCHES
      );
    } catch (error) {
      return errorResult(
        "PAN_CATALOG_METADATA_INVALID",
        error instanceof Error ? error.message : "目录任务元数据无效"
      );
    }

    // The target ledger has no separate lease column yet.  Binding owner to
    // both run ID and the monotonic generic fence prevents an old claim from
    // finishing targets after a lease hand-off.
    const owner = `${run.run_id}:${run.lease_fence}`;
    const shouldContinue = async () => !(await isCancelled(context));
    const finish = async (
      status: PluginJobStatus,
      error?: PluginJobErrorSnapshot
    ): Promise<PluginJobHandlerResult> => {
      await syncLegacy(dependencies, context, status, error);
      return {
        status: status as PluginJobHandlerResult["status"],
        ...(error ? { error } : {}),
      };
    };

    try {
      if (!(await shouldContinue())) return finish("cancelled");

      const discovery = await dependencies.discoverAndEnqueue({
        runId: run.run_id,
        signal: context.signal,
        profileId: run.profile_id,
        shouldContinue,
      });

      let total = Math.max(0, discovery.discovered);
      let processed = 0;
      let created = 0;
      let failed = 0;
      let skipped = 0;
      let remaining = 0;
      let imported = 0;
      let refreshed = 0;
      let disabled = 0;
      let lastTargetId: string | undefined;
      let lastBatch: PanSyncTargetBatchResult | undefined;

      await context.reportProgress({
        total,
        processed,
        created,
        failed,
        skipped,
      });
      await syncLegacy(dependencies, context);

      // A discovery with no usable source is a hard failure.  Do this before
      // queueing stale targets so a broken upstream cannot look successful.
      if (discovery.discovered === 0 && discovery.sourceErrors.length > 0) {
        const result = errorResult(
          "PAN_CATALOG_SOURCE_FAILURE",
          discovery.sourceErrors.join("; ")
        );
        await syncLegacy(dependencies, context, "failed", result.error);
        return result;
      }
      if (!(await shouldContinue())) return finish("cancelled");

      await dependencies.queueDue();

      for (let batch = 0; batch < maxBatches; batch += 1) {
        if (!(await shouldContinue())) return finish("cancelled");
        const result = await dependencies.runBatch(
          batchLimit,
          owner,
          undefined,
          {
            shouldContinue,
            execution: {
              profileId: run.profile_id,
              runId: run.run_id,
              signal: context.signal,
            },
            onTargetStart(target) {
              lastTargetId = target.douban_id;
            },
          }
        );
        lastBatch = result;
        const delta = progressDelta(result);
        processed += Math.max(0, Math.floor(result.processed || 0));
        created += delta.created;
        failed += delta.failed;
        skipped += delta.skipped;
        imported += Math.max(0, Math.floor(result.imported || 0));
        refreshed += Math.max(0, Math.floor(result.refreshed || 0));
        disabled += Math.max(0, Math.floor(result.disabled || 0));
        remaining = Math.max(0, Math.floor(result.remaining || 0));
        total = Math.max(total, processed + remaining);

        await context.reportProgress({
          total,
          processed,
          created,
          failed,
          skipped,
        });
        if (typeof context.setCursor === "function") {
          await context.setCursor(
            encodeCursor({
              batch: batch + 1,
              lastTargetId,
              remaining,
              imported,
              refreshed,
              disabled,
            })
          );
        }
        await syncLegacy(dependencies, context);

        if (result.processed === 0 || remaining <= 0) break;
      }

      if (!(await shouldContinue())) return finish("cancelled");
      const stats =
        lastBatch?.stats ||
        (dependencies.getStats ? await dependencies.getStats() : undefined);
      const pending = Math.max(0, stats?.pending || 0);
      const staleFailures = Math.max(0, stats?.failed || 0);
      if (failed > 0 || staleFailures > 0) {
        const failureCount = Math.max(failed, staleFailures);
        const error = {
          code: "PAN_CATALOG_TARGET_FAILURE",
          message: `${failureCount} 部影片同步失败`,
          retryable: false,
        } as const;
        return finish(processed > failureCount ? "partial" : "failed", error);
      }
      if (remaining > 0 || pending > 0) {
        return finish("partial", {
          code: "PAN_CATALOG_BATCH_LIMIT",
          message: "达到本次任务批次上限，仍有影片待同步",
          retryable: false,
        });
      }
      if (discovery.sourceErrors.length > 0) {
        return finish("partial", {
          code: "PAN_CATALOG_SOURCE_PARTIAL",
          message: `目录发现有 ${discovery.sourceErrors.length} 个来源失败，结果可能不完整`,
          retryable: false,
        });
      }
      return finish("succeeded");
    } catch (error) {
      // A fenced mutation failure must reach PluginHostExecutor so it can
      // avoid finalising the run with a stale lease.  The handler never logs
      // the credential (or any part of its token).
      if (isLeaseLoss(error)) throw error;
      if (await isCancelled(context).catch(() => false)) {
        return finish("cancelled");
      }
      const result = errorResult(
        "PAN_CATALOG_HANDLER_ERROR",
        error instanceof Error ? error.message : "KKPAN 目录同步失败"
      );
      await syncLegacy(dependencies, context, "failed", result.error);
      return result;
    }
  };
}

export function createPanCatalogHostJobRegistration(
  options: PanCatalogHostHandlerOptions = {}
): PluginJobHandlerRegistration {
  return {
    jobId: PAN_CATALOG_JOB_ID,
    pluginId: KKPAN_PLUGIN_ID,
    pluginVersion: kkpanCloudDriveManifest.version,
    execute: createPanCatalogHostJobHandler(options),
  };
}

/** Provider-neutral aliases used by host bootstrap code and contract tests. */
export const createPanCatalogHostHandler = createPanCatalogHostJobHandler;
export const createPanCatalogHostHandlerRegistration =
  createPanCatalogHostJobRegistration;

/** Build the static registry used by the eventual host cutover. */
export function createPanCatalogHostJobHandlerRegistry(
  options: PanCatalogHostHandlerOptions = {}
): ReadonlyMap<string, PluginJobHandlerRegistration> {
  return createPluginJobHandlerRegistry([
    createPanCatalogHostJobRegistration(options),
  ]);
}
