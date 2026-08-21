/**
 * Compatibility mapping for the existing Mongo-backed pan scheduler.
 *
 * This is intentionally a snapshot adapter, not a second scheduler.  It gives
 * job-center consumers the provider-neutral shape while the scheduler keeps
 * its current lease/worker implementation.  The write-side runner can replace
 * this mapper once PanSyncRunDoc is migrated to PluginJobStore atomics.
 */

import type { PanSyncRun } from "@/lib/pan/scheduler";
import type {
  PluginJobProgress,
  PluginJobRetryPolicy,
  PluginJobRun,
} from "@/lib/plugins/job-runner";

const COMPAT_RETRY_POLICY: PluginJobRetryPolicy = Object.freeze({
  // The legacy scheduler has no durable retry attempt counter yet.  Keeping
  // this at one prevents a consumer from assuming automatic retries exist.
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
});

/** Convert a public PanSyncRun snapshot into the generic job-center shape. */
export function adaptPanSyncRunToPluginJobRun(run: PanSyncRun): PluginJobRun {
  const progress: PluginJobProgress = {
    total: Math.max(0, run.progress_total),
    processed: Math.max(0, run.processed),
    created: Math.max(0, run.imported),
    failed: Math.max(0, run.failed),
    skipped: Math.max(0, run.empty + run.disabled),
  };
  const attempt = run.status === "queued" ? 0 : 1;
  return {
    run_id: run.run_id,
    plugin_id: run.plugin_id,
    plugin_version: run.plugin_version,
    profile_id: run.profile_id,
    profile: run.profile,
    config_version: run.config_version,
    actor: { ...run.actor },
    idempotency_key: run.idempotency_key,
    status: run.status,
    attempt,
    retry_policy: COMPAT_RETRY_POLICY,
    cancel_requested: run.cancel_requested,
    progress,
    ...(run.last_error
      ? { error: { message: run.last_error, retryable: false } }
      : {}),
    metadata: {
      task: run.task,
      trigger: run.trigger,
      batch_limit: run.batch_limit,
      max_batches: run.max_batches,
      completed_batches: run.completed_batches,
      remaining: run.remaining,
    },
    // PanSyncRun's public DTO does not expose its internal CAS revision. The
    // adapter therefore marks snapshots as revision zero; a durable write
    // adapter must use PanSyncRunDoc's revision/updated_at predicate instead.
    revision: 0,
    created_at: run.created_at,
    updated_at: run.updated_at,
    ...(run.started_at ? { started_at: run.started_at } : {}),
    ...(run.finished_at ? { finished_at: run.finished_at } : {}),
  };
}
