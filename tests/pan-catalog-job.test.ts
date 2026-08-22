import assert from "node:assert/strict";
import test from "node:test";
import {
  createPanCatalogJobProjection,
  getPanCatalogJobMode,
  PAN_CATALOG_JOB_ID,
  PAN_CATALOG_JOB_MODE_ENV,
  panCatalogJobIdempotencyKey,
  toPanCatalogJobEnqueueInput,
  enqueuePanCatalogJobProjection,
} from "@/lib/pan/catalog-job";
import {
  createInMemoryPluginJobRunner,
  InMemoryPluginJobStore,
  PluginJobRunner,
  type PluginJobRun,
} from "@/lib/plugins/job-runner";

const source = {
  runId: "legacy-run-1",
  trigger: "scheduled" as const,
  batchLimit: 5,
  maxBatches: 100,
  scheduleSlot: "catalog:2026-08-23",
  pluginId: "kerkerker.kkpan-cloud-drive",
  pluginVersion: "1.0.0",
  profileId: "cn-default",
  profile: "cn-default",
  configVersion: "runtime",
  actor: { type: "system" as const, id: "pan-scheduler" },
};

test("catalog job migration mode defaults closed and rejects typos", () => {
  assert.equal(getPanCatalogJobMode({}), "off");
  assert.equal(
    getPanCatalogJobMode({ [PAN_CATALOG_JOB_MODE_ENV]: "SHADOW" }),
    "shadow"
  );
  assert.equal(
    getPanCatalogJobMode({ [PAN_CATALOG_JOB_MODE_ENV]: "cutover" }),
    "cutover"
  );
  assert.throws(
    () => getPanCatalogJobMode({ [PAN_CATALOG_JOB_MODE_ENV]: "shdow" }),
    new RegExp(PAN_CATALOG_JOB_MODE_ENV)
  );
});

test("scheduled slots produce a stable provider-neutral identity", () => {
  const first = createPanCatalogJobProjection(source, "shadow");
  const second = createPanCatalogJobProjection(
    { ...source, runId: "a-different-legacy-run" },
    "shadow"
  );

  assert.equal(first.jobId, PAN_CATALOG_JOB_ID);
  assert.equal(first.runId, "pan-catalog:legacy-run-1");
  assert.equal(first.legacyRunId, "legacy-run-1");
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.metadata.shadow, true);
  assert.equal(first.metadata.schedule_slot, "catalog:2026-08-23");
  assert.equal(first.metadata.legacy_run_id, "legacy-run-1");
});

test("manual runs use their unique run ID as the logical window", () => {
  const first = { ...source, trigger: "manual" as const, scheduleSlot: undefined };
  const second = { ...first, runId: "legacy-run-2" };
  assert.notEqual(
    panCatalogJobIdempotencyKey(first),
    panCatalogJobIdempotencyKey(second)
  );
});

test("projection converts to a host enqueue shape without enabling execution", () => {
  const projection = createPanCatalogJobProjection(source, "cutover");
  const input = toPanCatalogJobEnqueueInput(projection);

  assert.deepEqual(input, {
    runId: "pan-catalog:legacy-run-1",
    jobId: PAN_CATALOG_JOB_ID,
    controlMode: "host",
    pluginId: "kerkerker.kkpan-cloud-drive",
    pluginVersion: "1.0.0",
    profileId: "cn-default",
    profile: "cn-default",
    configVersion: "runtime",
    actor: { type: "system", id: "pan-scheduler" },
    idempotencyKey:
      "job:kerkerker.kkpan-cloud-drive:resource.cloud-drive.catalog-sync:cn-default:schedule:catalog:2026-08-23",
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    metadata: {
      source: "pan-scheduler",
      task: "catalog",
      trigger: "scheduled",
      batch_limit: 5,
      max_batches: 100,
      schedule_slot: "catalog:2026-08-23",
      legacy_run_id: "legacy-run-1",
      migration_mode: "cutover",
      shadow: false,
    },
  });
});

test("shadow projection cannot be converted into an executable host task", () => {
  const projection = createPanCatalogJobProjection(source, "shadow");
  assert.throws(
    () => toPanCatalogJobEnqueueInput(projection),
    /只有 cutover 目录任务才能进入宿主任务队列/
  );
});

test("shadow dual-write is durable but excluded from host claims", async () => {
  const runner = createInMemoryPluginJobRunner();
  const shadow = await enqueuePanCatalogJobProjection(runner, source, "shadow");
  assert.equal(shadow?.job_id, PAN_CATALOG_JOB_ID);
  assert.equal(shadow?.host_claimable, false);
  assert.equal(shadow?.metadata.shadow, true);
  assert.equal(
    await runner.claimNext({ owner: "host", jobIds: [PAN_CATALOG_JOB_ID] }),
    null
  );
  await assert.rejects(
    runner.start({ runId: shadow!.run_id, owner: "host" }),
    /影子迁移任务不能由宿主领取/
  );
});

test("cutover projection is the only mode that can be claimed", async () => {
  const runner = createInMemoryPluginJobRunner();
  const cutover = await enqueuePanCatalogJobProjection(
    runner,
    { ...source, runId: "cutover-run", scheduleSlot: undefined, trigger: "manual" },
    "cutover"
  );
  assert.equal(cutover?.host_claimable, undefined);
  const claimed = await runner.claimNext({ owner: "host", jobIds: [PAN_CATALOG_JOB_ID] });
  assert.equal(claimed?.run_id, cutover?.run_id);
});

test("cutover reuses a queued shadow identity through an atomic promotion", async () => {
  const runner = createInMemoryPluginJobRunner();
  const shadow = await enqueuePanCatalogJobProjection(runner, source, "shadow");
  const promoted = await enqueuePanCatalogJobProjection(runner, source, "cutover");
  assert.equal(promoted?.run_id, shadow?.run_id);
  assert.equal(promoted?.host_claimable, true);
  const claimed = await runner.claimNext({ owner: "host", jobIds: [PAN_CATALOG_JOB_ID] });
  assert.equal(claimed?.run_id, shadow?.run_id);
});

test("cutover promotes a shadow returned by a concurrent create race", async () => {
  class RaceStore extends InMemoryPluginJobStore {
    private injected = false;

    override async create(run: PluginJobRun): Promise<PluginJobRun> {
      if (!this.injected) {
        this.injected = true;
        return super.create({
          ...run,
          host_claimable: false,
          metadata: {
            ...run.metadata,
            migration_mode: "shadow",
            shadow: true,
          },
        });
      }
      return super.create(run);
    }
  }

  const runner = new PluginJobRunner(new RaceStore());
  const promoted = await enqueuePanCatalogJobProjection(
    runner,
    source,
    "cutover"
  );
  assert.equal(promoted?.host_claimable, true);
  assert.equal(promoted?.metadata.shadow, false);
  assert.equal(
    (await runner.claimNext({ owner: "host", jobIds: [PAN_CATALOG_JOB_ID] }))?.run_id,
    promoted?.run_id
  );
});

test("shadow cannot win a concurrent create race against an executable job", async () => {
  class HostRaceStore extends InMemoryPluginJobStore {
    private injected = false;

    override async create(run: PluginJobRun): Promise<PluginJobRun> {
      if (!this.injected) {
        this.injected = true;
        return super.create({ ...run, host_claimable: true });
      }
      return super.create(run);
    }
  }

  const runner = new PluginJobRunner(new HostRaceStore());
  await assert.rejects(
    enqueuePanCatalogJobProjection(runner, source, "shadow"),
    /不能降级为影子任务/
  );
});
