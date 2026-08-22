import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryPluginJobStore,
  PluginJobRunner as PluginJobRunnerImplementation,
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobLeaseCredential,
  type PluginJobRun,
  type PluginJobRunner,
} from "@/lib/plugins/job-runner";
import {
  adaptPanSyncRunToPluginJobRun,
  adaptPanSyncRunsToPluginJobRuns,
} from "@/lib/pan/job-runner-adapter";

function input(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "example.cloud-drive",
    jobId: "resource.cloud-drive.sync",
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

function leaseCredential(run: PluginJobRun): PluginJobLeaseCredential {
  assert.ok(run.lease);
  return {
    owner: run.lease.owner,
    token: run.lease.token,
    fence: run.lease.fence,
  };
}

function makeRunner() {
  let now = new Date("2026-08-21T00:00:00.000Z");
  const store = new InMemoryPluginJobStore();
  const runner = new PluginJobRunnerImplementation(store, {
    now: () => now,
    defaultLeaseTtlMs: 1_000,
    defaultRetryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
  });
  return {
    runner,
    store,
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
  await assert.rejects(
    () => enqueue(runner, { jobId: "resource.cloud-drive.refresh" }),
    (error: unknown) =>
      error instanceof PluginJobError &&
      error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
});

test("concurrent enqueue rejects a conflicting idempotency identity", async () => {
  const { runner } = makeRunner();
  const results = await Promise.allSettled([
    enqueue(runner, {
      idempotencyKey: "concurrent:identity",
      jobId: "content.catalog.daily",
    }),
    enqueue(runner, {
      idempotencyKey: "concurrent:identity",
      jobId: "content.catalog.manual",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof PluginJobError);
  assert.equal(rejected.reason.code, PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT);
});

test("job runner owns a lease and keeps progress and cursor monotonic", async () => {
  const { runner, advance } = makeRunner();
  const queued = await enqueue(runner);
  const running = await runner.start({ runId: queued.run_id, owner: "worker-a" });
  assert.equal(running.status, "running");
  assert.equal(running.attempt, 1);
  assert.equal(running.lease?.owner, "worker-a");
  assert.equal(running.lease?.fence, 1);
  assert.equal(running.lease_fence, 1);
  const credential = leaseCredential(running);

  await assert.rejects(
    () => runner.start({ runId: queued.run_id, owner: "worker-b" }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.LEASE_BUSY
  );

  const progressed = await runner.reportProgress(running.run_id, credential, {
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
  await runner.setCursor(running.run_id, credential, "cursor-3");

  await assert.rejects(
    () => runner.reportProgress(running.run_id, credential, { processed: 2 }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.INVALID_PROGRESS
  );

  advance(500);
  const heartbeated = await runner.heartbeat(running.run_id, credential);
  assert.equal(heartbeated.cursor, "cursor-3");
  assert.equal(heartbeated.heartbeat_at, "2026-08-21T00:00:00.500Z");

  const finished = await runner.finish(running.run_id, credential, { status: "succeeded" });
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
  const running = await runner.start({ runId: active.run_id, owner: "worker-a" });
  const credential = leaseCredential(running);
  const requested = await runner.requestCancel(active.run_id);
  assert.equal(requested?.status, "running");
  assert.equal(requested?.cancel_requested, true);
  await assert.rejects(
    () => runner.finish(active.run_id, credential, { status: "succeeded" }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.INVALID_STATE
  );
  const stopped = await runner.finish(active.run_id, credential, { status: "cancelled" });
  assert.equal(stopped.status, "cancelled");
});

test("cancellation retries when a queued run is claimed concurrently", async () => {
  const { runner, store } = makeRunner();
  const queued = await enqueue(runner, { idempotencyKey: "cancel:claim-race" });
  const update = store.update.bind(store);
  let injected = false;
  store.update = async (...args) => {
    if (!injected) {
      injected = true;
      const claimed = await runner.claimNext({ owner: "worker-race" });
      assert.equal(claimed?.status, "running");
      return null;
    }
    return update(...args);
  };

  const cancelled = await runner.requestCancel(queued.run_id);
  assert.equal(injected, true);
  assert.equal(cancelled?.status, "running");
  assert.equal(cancelled?.cancel_requested, true);
  assert.equal(cancelled?.lease?.owner, "worker-race");
});

test("cancellation retries when a heartbeat wins the first CAS", async () => {
  const { runner, store } = makeRunner();
  const queued = await enqueue(runner, { idempotencyKey: "cancel:heartbeat-race" });
  const running = await runner.start({ runId: queued.run_id, owner: "worker-race" });
  const credential = leaseCredential(running);
  const update = store.update.bind(store);
  let injected = false;
  store.update = async (...args) => {
    if (!injected) {
      injected = true;
      const heartbeated = await runner.heartbeat(running.run_id, credential);
      assert.equal(heartbeated.revision, running.revision + 1);
      return null;
    }
    return update(...args);
  };

  const cancelled = await runner.requestCancel(running.run_id);
  assert.equal(injected, true);
  assert.equal(cancelled?.status, "running");
  assert.equal(cancelled?.cancel_requested, true);
  assert.equal(cancelled?.revision, running.revision + 2);
});

test("retry uses exponential backoff and enforces max attempts", async () => {
  const { runner, advance } = makeRunner();
  const queued = await enqueue(runner, {
    idempotencyKey: "retry:1",
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
  });
  let running = await runner.start({ runId: queued.run_id, owner: "worker-a" });
  await runner.finish(queued.run_id, leaseCredential(running), {
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
  running = await runner.start({ runId: queued.run_id, owner: "worker-a" });
  await runner.finish(queued.run_id, leaseCredential(running), { status: "partial" });
  const secondRetry = await runner.retry(queued.run_id);
  assert.equal(secondRetry.next_retry_at, "2026-08-21T00:00:00.300Z");

  advance(200);
  running = await runner.start({ runId: queued.run_id, owner: "worker-a" });
  await runner.finish(queued.run_id, leaseCredential(running), { status: "failed" });
  await assert.rejects(
    () => runner.retry(queued.run_id),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED
  );
});

test("expired leases cannot write progress and can be explicitly reclaimed", async () => {
  const { runner, advance } = makeRunner();
  const queued = await enqueue(runner, { idempotencyKey: "lease:1" });
  const first = await runner.start({ runId: queued.run_id, owner: "worker-a", leaseTtlMs: 1_000 });
  const staleCredential = leaseCredential(first);
  advance(1_001);
  await assert.rejects(
    () => runner.reportProgress(queued.run_id, staleCredential, { processed: 1 }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED
  );
  const reclaimed = await runner.start({ runId: queued.run_id, owner: "worker-a" });
  assert.equal(reclaimed.status, "running");
  assert.equal(reclaimed.attempt, 2);
  assert.equal(reclaimed.lease?.owner, "worker-a");
  assert.equal(reclaimed.lease?.fence, 2);
  assert.notEqual(reclaimed.lease?.token, first.lease?.token);
  await assert.rejects(
    () => runner.reportProgress(queued.run_id, staleCredential, { processed: 1 }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED
  );
  await assert.rejects(
    () => runner.finish(queued.run_id, staleCredential, { status: "succeeded" }),
    (error: unknown) =>
      error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED
  );
});

test("claimNext is single-winner and excludes cancelled, future, and external runs", async () => {
  const { runner, store } = makeRunner();
  await enqueue(runner, { idempotencyKey: "claim:single" });
  const claims = await Promise.all(
    Array.from({ length: 20 }, () => runner.claimNext({ owner: "worker-shared" }))
  );
  const winners = claims.filter((run): run is PluginJobRun => Boolean(run));
  assert.equal(winners.length, 1);
  assert.equal(winners[0].lease?.fence, 1);
  assert.equal(await runner.claimNext({ owner: "worker-shared" }), null);

  const cancelled = await enqueue(runner, { idempotencyKey: "claim:cancelled" });
  await runner.requestCancel(cancelled.run_id);

  const waiting = await enqueue(runner, {
    idempotencyKey: "claim:future",
    retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100 },
  });
  const waitingRun = await runner.start({ runId: waiting.run_id, owner: "worker-wait" });
  await runner.finish(waiting.run_id, leaseCredential(waitingRun), { status: "failed" });
  await runner.retry(waiting.run_id);

  const externalTemplate = await enqueue(runner, { idempotencyKey: "claim:external-template" });
  await runner.requestCancel(externalTemplate.run_id);
  await store.create({
    ...externalTemplate,
    run_id: "external-run",
    idempotency_key: "claim:external",
    job_id: "content.refresh.daily",
    control_mode: "external-report",
    status: "running",
    attempt: 1,
  });

  assert.equal(await runner.claimNext({ owner: "worker-next" }), null);
});

test("malformed host_claimable values fail closed in the in-memory store", async () => {
  const store = new InMemoryPluginJobStore();
  const runner = new PluginJobRunnerImplementation(store);
  const malformed = await enqueue(runner, { idempotencyKey: "claim:malformed" });
  await store.update(malformed.run_id, malformed.revision, (run) => ({
    ...run,
    host_claimable: "yes" as unknown as boolean,
  }));
  assert.equal(await runner.claimNext({ owner: "host" }), null);
  await assert.rejects(
    runner.start({ runId: malformed.run_id, owner: "host" }),
    /影子迁移任务不能由宿主领取/
  );
});

test("expired cancelled and exhausted runs converge to terminal states", async () => {
  const { runner, advance } = makeRunner();
  const cancelled = await enqueue(runner, { idempotencyKey: "recover:cancelled" });
  await runner.start({ runId: cancelled.run_id, owner: "worker-cancel", leaseTtlMs: 1_000 });
  await runner.requestCancel(cancelled.run_id);
  advance(1_001);
  assert.equal(await runner.claimNext({ owner: "worker-recovery" }), null);
  const cancelledSnapshot = await runner.get(cancelled.run_id);
  assert.equal(cancelledSnapshot?.status, "cancelled");
  assert.equal(cancelledSnapshot?.lease, undefined);

  const exhausted = await enqueue(runner, {
    idempotencyKey: "recover:exhausted",
    retryPolicy: { maxAttempts: 1 },
  });
  await runner.start({ runId: exhausted.run_id, owner: "worker-exhausted", leaseTtlMs: 1_000 });
  advance(1_001);
  assert.equal(await runner.claimNext({ owner: "worker-recovery" }), null);
  const failedSnapshot = await runner.get(exhausted.run_id);
  assert.equal(failedSnapshot?.status, "failed");
  assert.equal(failedSnapshot?.lease, undefined);
  assert.equal(failedSnapshot?.error?.code, PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED);
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
  assert.equal(generic.job_id, "legacy.pan.catalog");
  assert.equal(generic.control_mode, "host");
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

test("batch pan snapshots expose a read-only generic view without changing legacy states", () => {
  const base = {
    run_id: "pan-run-batch",
    plugin_id: "kerkerker.kkpan-cloud-drive",
    plugin_version: "1.4.0",
    profile_id: "cn-default",
    profile: "cn-default",
    config_version: "runtime",
    actor: { type: "system" as const, id: "pan-scheduler" },
    idempotency_key: "pan-sync:pan-run-batch",
    task: "incremental" as const,
    trigger: "manual" as const,
    status: "queued" as const,
    batch_limit: 50,
    max_batches: 1,
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
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
  };
  const [generic] = adaptPanSyncRunsToPluginJobRuns([base]);
  assert.equal(generic?.status, "queued");
  assert.equal(generic?.retry_policy.maxAttempts, 1);
  assert.deepEqual(generic?.metadata, {
    task: "incremental",
    trigger: "manual",
    batch_limit: 50,
    max_batches: 1,
    completed_batches: 0,
    remaining: 0,
  });
});

test("shadow Pan projections expose the canonical job identity without becoming claimable", () => {
  const [generic] = adaptPanSyncRunsToPluginJobRuns([
    {
      run_id: "legacy-pan-run",
      plugin_id: "kerkerker.kkpan-cloud-drive",
      plugin_version: "1.0.0",
      profile_id: "cn-default",
      profile: "cn-default",
      config_version: "runtime",
      actor: { type: "system", id: "pan-scheduler" },
      idempotency_key: "pan-sync:legacy-pan-run",
      task: "catalog",
      trigger: "scheduled",
      status: "queued",
      batch_limit: 5,
      max_batches: 100,
      schedule_slot: "catalog:2026-08-23",
      generic_job_id: "resource.cloud-drive.catalog-sync",
      generic_job_run_id: "pan-catalog:legacy-pan-run",
      generic_job_mode: "shadow",
      generic_job_idempotency_key:
        "job:kerkerker.kkpan-cloud-drive:resource.cloud-drive.catalog-sync:cn-default:schedule:catalog:2026-08-23",
      generic_job_projected_at: "2026-08-23T00:00:00.000Z",
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
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    },
  ]);
  assert.equal(generic?.run_id, "pan-catalog:legacy-pan-run");
  assert.equal(generic?.job_id, "resource.cloud-drive.catalog-sync");
  assert.equal(generic?.host_claimable, false);
  assert.equal(generic?.metadata.legacy_run_id, "legacy-pan-run");
});
