/**
 * Compatibility projection from a generic catalog run back to pan_sync_runs.
 *
 * The generic job is the execution source after cutover. This bridge only
 * updates the legacy read model and is fenced by both legacy and generic run
 * IDs, so a stale worker cannot overwrite another projection.
 */

import { getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import type { PluginJobRun, PluginJobStatus } from "@/lib/plugins/job-runner";
import { redactPluginJobEventText } from "@/lib/plugins/job-events";

interface CatalogCursorSnapshot {
  readonly version?: number;
  readonly batch?: number;
  readonly last_target_id?: string;
  readonly remaining?: number;
  readonly imported?: number;
  readonly refreshed?: number;
  readonly disabled?: number;
}

export interface PanCatalogLegacyProjectionInput {
  readonly legacyRunId: string;
  readonly run: PluginJobRun;
  readonly status?: PluginJobStatus;
  readonly error?: { readonly code?: string; readonly message: string };
}

function parseCursor(cursor: string | undefined): CatalogCursorSnapshot {
  if (!cursor) return {};
  try {
    const value: unknown = JSON.parse(cursor);
    if (!value || typeof value !== "object") return {};
    const record = value as Record<string, unknown>;
    const number = (key: string): number | undefined => {
      const candidate = record[key];
      return typeof candidate === "number" && Number.isSafeInteger(candidate)
        ? Math.max(0, candidate)
        : undefined;
    };
    return {
      version: number("version"),
      batch: number("batch"),
      last_target_id:
        typeof record.last_target_id === "string"
          ? record.last_target_id.slice(0, 200)
          : undefined,
      remaining: number("remaining"),
      imported: number("imported"),
      refreshed: number("refreshed"),
      disabled: number("disabled"),
    };
  } catch {
    return {};
  }
}

function legacyStatus(status: PluginJobStatus):
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled" {
  if (status === "retry_waiting") return "queued";
  return status;
}

/** Best-effort compatibility update; generic job state remains authoritative. */
export async function syncPanCatalogLegacyProjection(
  input: PanCatalogLegacyProjectionInput
): Promise<boolean> {
  const run = input.run;
  const cursor = parseCursor(run.cursor);
  const progress = run.progress;
  const status = legacyStatus(input.status || run.status);
  const now = new Date().toISOString();
  const errorMessage = input.error?.message || run.error?.message;
  const update: Record<string, unknown> = {
    status,
    discovered: progress.total,
    queued: progress.total,
    processed: progress.processed,
    synced: progress.created,
    empty: progress.skipped,
    failed: progress.failed,
    progress_total: progress.total,
    remaining: cursor.remaining ?? Math.max(progress.total - progress.processed, 0),
    completed_batches: cursor.batch ?? 0,
    imported: cursor.imported ?? progress.created,
    refreshed: cursor.refreshed ?? 0,
    disabled: cursor.disabled ?? 0,
    updated_at: now,
    ...(run.started_at ? { started_at: run.started_at } : {}),
    ...(run.heartbeat_at ? { heartbeat_at: run.heartbeat_at } : {}),
    ...(run.lease?.owner ? { owner: run.lease.owner } : {}),
    ...(cursor.last_target_id ? { current_douban_id: cursor.last_target_id } : {}),
  };
  if (status === "succeeded" || status === "partial" || status === "failed" || status === "cancelled") {
    update.finished_at = run.finished_at || now;
    update.cancel_requested = status === "cancelled" || run.cancel_requested;
    if (errorMessage) {
      update.last_error = redactPluginJobEventText(errorMessage).slice(0, 1500);
    }
  }
  const result = await (await getDatabase())
    .collection(COLLECTIONS.PAN_SYNC_RUNS)
    .updateOne(
      {
        run_id: input.legacyRunId,
        generic_job_run_id: run.run_id,
        generic_job_mode: "cutover",
      },
      { $set: update }
    );
  return result.modifiedCount === 1;
}

