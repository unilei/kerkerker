import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryPluginJobRunner,
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobRunner,
} from "@/lib/plugins/job-runner";
import { adaptPanSyncRunToPluginJobRun } from "@/lib/pan/job-runner-adapter";

function input(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "example.cloud-drive",
    pluginVersion: "1.0.0",
    profileId: "cn-default",
    profile: "cn-default",
    configVersion: "config-1",
    actor: { type: "system" as const, id: "test" },
    idempotencyKey: "job:example:1",
    metadata: { source: "test" },
    ...overrides,
  };
}

function makeRunner() {
  let now = new Date("2026-08-21T00:00:00.000Z");
  const runner = createInMemoryPluginJobRunner({
    now: () => now,
    defaultLeaseTtlMs: 1_000,
    defaultRetryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
  });
  return {
    runner,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

async function enqueue(runner: PluginJobRunner, overrides: Record<string, unknown> = {}) {
  return runner.enqueue(input(overrides));
}

test("job runner keeps idempotent metadata snapshots", async () => {
  const { runner } = makeRunner();
  const first = await enqueue(runner);
  assert.equal(first.expires_at?.toISOString(), "2026-09-20T00:00:00.000Z");
  const duplicate = await enqueue(runner, {
    metadata: { source: "changed" },
    runId: "a-different-run-id",
  });
  assert.equal(duplicate.run_id, first.run_id);
  assert.deepEqual(duplicate.metadata, { source: "test" });

  await assert.rejects(
    () => enqueue(runner, { pluginId: "other.plugin" }),
    (error: unknown) =>
      error instanceof PluginJobError &&
      error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
  await assert.rejects(
    () => enqueue(runner, { pluginVersion: "2.0.0" }),
    (error: unknown) =>
      error instanceof PluginJobError &&
      error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
  await assert.rejects(
    () => enqueue(runner, { configVersion: "config-2" }),
    (error: unknown) =>
      error instanceof PluginJobError &&
      error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
});

test("job runner owns a lease and keeps progress and cursor monotonic", async () => {
  const { runner, advance } = makeRunner();
  const queued = await enqueue(runner);
  const running = await runner.start({ runId: queued.run_id, owner: "worker-a" });
  assert.equal(running.status, "running");
  assert.equal(running.attempt, 1);
  assert.equal(running.lease?.owner, "worker-a");

  await assert.rejects(
    () => runner.start({ runId: queued.run_id, owner: "worker-b" }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.LEASE_BUSY
  );

  const progressed = await runner.reportProgress(running.run_id, "worker-a", {
    total: 10,
    processed: 3,
    created: 2,
    skipped: 1,
  });
  assert.deepEqual(progressed.progress, {
    total: 10,
    processed: 3,
    created: 2,
    failed: 0,
    skipped: 1,
  });
  await runner.setCursor(running.run_id, "worker-a", "cursor-3");

  await assert.rejects(
    () => runner.reportProgress(running.run_id, "worker-a", { processed: 2 }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.INVALID_PROGRESS
  );

  advance(500);
  const heartbeated = await runner.heartbeat(running.run_id, "worker-a");
  assert.equal(heartbeated.cursor, "cursor-3");
  assert.equal(heartbeated.heartbeat_at, "2026-08-21T00:00:00.500Z");

  const finished = await runner.finish(running.run_id, "worker-a", { status: "succeeded" });
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.lease, undefined);
  assert.equal(finished.finished_at, "2026-08-21T00:00:00.500Z");
});

test("queued and running jobs have cooperative cancellation", async () => {
  const { runner } = makeRunner();
  const queued = await enqueue(runner, { idempotencyKey: "cancel:queued" });
  const cancelled = await runner.requestCancel(queued.run_id);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(await runner.isCancellationRequested(queued.run_id), true);

  const active = await enqueue(runner, { idempotencyKey: "cancel:running" });
  await runner.start({ runId: active.run_id, owner: "worker-a" });
  const requested = await runner.requestCancel(active.run_id);
  assert.equal(requested?.status, "running");
  assert.equal(requested?.cancel_requested, true);
  await assert.rejects(
    () => runner.finish(active.run_id, "worker-a", { status: "succeeded" }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.INVALID_STATE
  );
  const stopped = await runner.finish(active.run_id, "worker-a", { status: "cancelled" });
  assert.equal(stopped.status, "cancelled");
});

test("retry uses exponential backoff and enforces max attempts", async () => {
  const { runner, advance } = makeRunner();
  const queued = await enqueue(runner, {
    idempotencyKey: "retry:1",
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
  });
  await runner.start({ runId: queued.run_id, owner: "worker-a" });
  await runner.finish(queued.run_id, "worker-a", {
    status: "failed",
    error: { code: "UPSTREAM_ERROR", message: "temporary", retryable: true },
  });

  const waiting = await runner.retry(queued.run_id);
  assert.equal(waiting.status, "retry_waiting");
  assert.equal(waiting.next_retry_at, "2026-08-21T00:00:00.100Z");
  await assert.rejects(
    () => runner.start({ runId: queued.run_id, owner: "worker-a" }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.RETRY_NOT_DUE
  );

  advance(100);
  await runner.start({ runId: queued.run_id, owner: "worker-a" });
  await runner.finish(queued.run_id, "worker-a", { status: "partial" });
  const secondRetry = await runner.retry(queued.run_id);
  assert.equal(secondRetry.next_retry_at, "2026-08-21T00:00:00.300Z");

  advance(200);
  await runner.start({ runId: queued.run_id, owner: "worker-a" });
  await runner.finish(queued.run_id, "worker-a", { status: "failed" });
  await assert.rejects(
    () => runner.retry(queued.run_id),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED
  );
});

test("expired leases cannot write progress and can be explicitly reclaimed", async () => {
  const { runner, advance } = makeRunner();
  const queued = await enqueue(runner, { idempotencyKey: "lease:1" });
  await runner.start({ runId: queued.run_id, owner: "worker-a", leaseTtlMs: 1_000 });
  advance(1_001);
  await assert.rejects(
    () => runner.reportProgress(queued.run_id, "worker-a", { processed: 1 }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED
  );
  const reclaimed = await runner.start({ runId: queued.run_id, owner: "worker-b" });
  assert.equal(reclaimed.status, "running");
  assert.equal(reclaimed.attempt, 2);
  assert.equal(reclaimed.lease?.owner, "worker-b");
});

test("legacy pan scheduler snapshots map to the generic job contract", () => {
  const generic = adaptPanSyncRunToPluginJobRun({
    run_id: "pan-run-1",
    plugin_id: "kerkerker.kkpan-cloud-drive",
    plugin_version: "1.4.0",
    profile_id: "cn-default",
    profile: "cn-default",
    config_version: "runtime",
    actor: { type: "system", id: "pan-scheduler" },
    idempotency_key: "pan-sync:pan-run-1",
    task: "catalog",
    trigger: "scheduled",
    status: "partial",
    batch_limit: 5,
    max_batches: 2,
    discovered: 12,
    queued: 12,
    processed: 10,
    synced: 8,
    empty: 1,
    failed: 1,
    imported: 8,
    refreshed: 2,
    disabled: 0,
    remaining: 2,
    progress_total: 12,
    completed_batches: 2,
    last_error: "2 个来源暂时不可用",
    cancel_requested: false,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:01:00.000Z",
    started_at: "2026-08-21T00:00:01.000Z",
    finished_at: "2026-08-21T00:01:00.000Z",
  });
  assert.equal(generic.run_id, "pan-run-1");
  assert.equal(generic.status, "partial");
  assert.deepEqual(generic.progress, {
    total: 12,
    processed: 10,
    created: 8,
    failed: 1,
    skipped: 1,
  });
  assert.equal(generic.metadata.task, "catalog");
  assert.equal(generic.retry_policy.maxAttempts, 1);
});
