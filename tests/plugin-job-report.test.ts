import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NextRequest } from "next/server";

import { createPluginJobReportRouteHandlers } from "@/app/api/plugins/jobs/report/route";
import {
  ingestPluginJobReport,
  parseJobReportEvent,
  type JobReportEvent,
  type JobReportIngestDependencies,
} from "@/lib/plugins/job-report";
import {
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobRun,
} from "@/lib/plugins/job-runner";

const base = {
  schema: "kerkerker.plugin-job.v1",
  event_id: "refresh-1:0",
  sequence: 0,
  kind: "started",
  occurred_at: "2026-08-21T00:00:00Z",
  metadata: {
    run_id: "refresh-1",
    plugin_id: "kerkerker.douban-content",
    plugin_version: "1.0.0",
    profile_id: "cn-default",
    config_version: "runtime",
    actor: "system/refresh",
    attempt: 1,
  },
  status: "running",
  progress: { total: 10, processed: 0, created: 0, failed: 0, skipped: 0 },
} as const;

const goldenEvent = JSON.parse(readFileSync(
  new URL("../packages/kerkerker-plugin-contract/fixtures/plugin-job-event.v1.valid.json", import.meta.url),
  "utf8"
)) as unknown;
const invalidEdgeWhitespaceEvent = JSON.parse(readFileSync(
  new URL("../packages/kerkerker-plugin-contract/fixtures/plugin-job-event.v1.invalid.json", import.meta.url),
  "utf8"
)) as unknown;
const reportToken = "test-report-token-0123456789abcdef";

function event(overrides: Record<string, unknown> = {}): JobReportEvent {
  const sequence = typeof overrides.sequence === "number" ? overrides.sequence : base.sequence;
  const metadata = { ...base.metadata, ...((overrides.metadata as object | undefined) || {}) };
  return parseJobReportEvent({
    ...base,
    ...overrides,
    event_id: overrides.event_id ?? `${metadata.run_id}:${sequence}`,
    metadata,
    progress: { ...base.progress, ...((overrides.progress as object | undefined) || {}) },
  });
}

function makeStore(): JobReportIngestDependencies & { snapshot(runId: string): PluginJobRun | null } {
  const runs = new Map<string, PluginJobRun>();
  const clone = (run: PluginJobRun): PluginJobRun => structuredClone(run);
  return {
    snapshot(runId) {
      const run = runs.get(runId);
      return run ? clone(run) : null;
    },
    async get(runId) {
      const run = runs.get(runId);
      return run ? clone(run) : null;
    },
    async create(run) {
      const winner = runs.get(run.run_id);
      if (winner) return clone(winner);
      runs.set(run.run_id, clone(run));
      return clone(run);
    },
    async update(runId, revision, mutate) {
      const current = runs.get(runId);
      if (!current || current.revision !== revision) return null;
      const next = mutate(clone(current));
      runs.set(runId, clone(next));
      return clone(next);
    },
  };
}

test("job report parser enforces deterministic IDs, sequence semantics, and progress", () => {
  assert.equal(event().event_id, "refresh-1:0");
  assert.deepEqual(parseJobReportEvent(goldenEvent), goldenEvent);
  assert.throws(() => event({ event_id: "arbitrary" }), /event_id/);
  assert.throws(() => event({ sequence: 1 }), /started/);
  assert.throws(() => event({ kind: "progress", sequence: 0 }), /sequence 0/);
  assert.throws(() => event({ progress: { processed: 11 } }), /不能超过 total/);
  assert.throws(() => event({ progress: { processed: 1, created: 1, failed: 1 } }), /分类计数/);
  assert.throws(() => event({ occurred_at: "2026-08-21" }), /RFC3339/);
  assert.throws(() => event({ occurred_at: "2026-02-30T24:00:00Z" }), /RFC3339/);
  assert.throws(() => event({ kind: "finished", sequence: 1, status: "running" }), /finished/);
  assert.throws(() => event({ kind: "finished", sequence: 1, status: "failed" }), /必须包含 error/);
  assert.throws(() => parseJobReportEvent({ ...base, extra: true }), /不属于任务事件契约/);
  assert.throws(() => event({ metadata: { actor: " system/refresh" } }), /actor/);
  assert.throws(() => parseJobReportEvent(invalidEdgeWhitespaceEvent), /actor/);
});

test("job report lifecycle timestamps use host receipt time exactly", async () => {
  const store = makeStore();
  const received = [
    "2026-08-22T08:00:00.000Z",
    "2026-08-22T08:01:00.000Z",
    "2026-08-22T08:02:00.000Z",
  ];
  let receipt = 0;
  const dependencies: JobReportIngestDependencies = {
    ...store,
    now: () => new Date(received[receipt++]),
  };

  const started = await ingestPluginJobReport(event({
    occurred_at: "2026-08-20T00:00:00Z",
  }), dependencies);
  assert.equal(started.created_at, received[0]);
  assert.equal(started.started_at, received[0]);
  assert.equal(started.updated_at, received[0]);
  assert.equal(started.metadata.last_received_at, received[0]);
  assert.equal(started.metadata.last_occurred_at, "2026-08-20T00:00:00Z");

  const progressed = await ingestPluginJobReport(event({
    kind: "progress",
    sequence: 1,
    occurred_at: "2026-08-19T00:00:00Z",
  }), dependencies);
  assert.equal(progressed.created_at, received[0]);
  assert.equal(progressed.started_at, received[0]);
  assert.equal(progressed.updated_at, received[1]);
  assert.equal(progressed.metadata.last_received_at, received[1]);
  assert.equal(progressed.metadata.last_occurred_at, "2026-08-19T00:00:00Z");

  const finished = await ingestPluginJobReport(event({
    kind: "finished",
    sequence: 2,
    status: "succeeded",
    occurred_at: "2026-08-18T00:00:00Z",
  }), dependencies);
  assert.equal(finished.created_at, received[0]);
  assert.equal(finished.started_at, received[0]);
  assert.equal(finished.updated_at, received[2]);
  assert.equal(finished.finished_at, received[2]);
  assert.equal(finished.metadata.last_received_at, received[2]);
  assert.equal(finished.metadata.last_occurred_at, "2026-08-18T00:00:00Z");
});

test("job report ingestion creates, deduplicates, advances, and seals a run", async () => {
  const store = makeStore();
  const started = await ingestPluginJobReport(event(), store);
  assert.equal(started.revision, 0);
  assert.equal(started.metadata.last_sequence, 0);

  const duplicateStart = await ingestPluginJobReport(event(), store);
  assert.equal(duplicateStart.revision, 0);

  const progressedEvent = event({
    kind: "progress",
    sequence: 1,
    occurred_at: "2026-08-21T00:01:00Z",
    progress: { processed: 4, created: 3, failed: 1 },
  });
  const progressed = await ingestPluginJobReport(progressedEvent, store);
  assert.equal(progressed.revision, 1);
  assert.equal(progressed.progress.processed, 4);
  assert.equal((await ingestPluginJobReport(progressedEvent, store)).revision, 1);

  const stale = await ingestPluginJobReport(event(), store);
  assert.equal(stale.revision, 1);

  const finishedEvent = event({
    kind: "finished",
    sequence: 3,
    occurred_at: "2026-08-21T00:02:00Z",
    status: "partial",
    progress: { processed: 10, created: 8, failed: 2 },
    error: { code: "UPSTREAM_PARTIAL", message: "two records failed" },
  });
  const finished = await ingestPluginJobReport(finishedEvent, store);
  assert.equal(finished.status, "partial");
  assert.equal(finished.revision, 2);
  assert.equal(finished.metadata.last_sequence, 3);
  assert.ok(finished.finished_at);
  assert.ok(finished.started_at);
  assert.ok(finished.finished_at >= finished.started_at);

  await assert.rejects(
    () => ingestPluginJobReport(event({
      kind: "progress",
      sequence: 4,
      occurred_at: "2026-08-21T00:03:00Z",
      progress: { processed: 10, created: 8, failed: 2 },
    }), store),
    (error: unknown) => error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.INVALID_STATE
  );
});

test("job report ingestion rejects mutated duplicates and identity changes", async () => {
  const store = makeStore();
  await ingestPluginJobReport(event(), store);
  await assert.rejects(
    () => ingestPluginJobReport(event({ progress: { total: 11 } }), store),
    (error: unknown) => error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
  await assert.rejects(
    () => ingestPluginJobReport(event({ metadata: { actor: "system/other" } }), store),
    (error: unknown) => error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
  const clockAdjusted = await ingestPluginJobReport(event({
    kind: "progress",
    sequence: 1,
    occurred_at: "2026-08-20T23:59:59Z",
  }), store);
  assert.equal(clockAdjusted.revision, 1);
  assert.equal(clockAdjusted.metadata.last_occurred_at, "2026-08-20T23:59:59Z");
  assert.ok(clockAdjusted.started_at);
  assert.ok(clockAdjusted.updated_at >= clockAdjusted.started_at);
  await assert.rejects(
    () => ingestPluginJobReport(event({
      kind: "progress",
      sequence: 1,
      occurred_at: "2026-08-20T23:59:59.000000001Z",
    }), store),
    (error: unknown) => error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
});

test("job report ingestion detects CAS loss without overwriting the winner", async () => {
  const store = makeStore();
  await ingestPluginJobReport(event(), store);
  const deps: JobReportIngestDependencies = {
    get: store.get,
    create: store.create,
    update: async () => null,
  };
  await assert.rejects(
    () => ingestPluginJobReport(event({ kind: "progress", sequence: 1 }), deps),
    (error: unknown) => error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.CONFLICT
  );
  assert.equal(store.snapshot("refresh-1")?.revision, 0);
});

test("job report ingestion resolves an identical concurrent CAS winner", async () => {
  const store = makeStore();
  await ingestPluginJobReport(event(), store);
  const progress = event({ kind: "progress", sequence: 1 });
  const resolved = await ingestPluginJobReport(progress, {
    get: store.get,
    create: store.create,
    update: async (runId, revision, mutate) => {
      const winner = await store.update(runId, revision, mutate);
      assert.ok(winner);
      return null;
    },
  });
  assert.equal(resolved.revision, 1);
  assert.equal(resolved.metadata.last_sequence, 1);
});

test("job report ingestion validates a concurrent create winner and registry scope", async () => {
  const store = makeStore();
  const winner = await ingestPluginJobReport(event(), store);
  await assert.rejects(
    () => ingestPluginJobReport(event(), {
      get: async () => null,
      create: async () => ({
        ...winner,
        metadata: { ...winner.metadata, last_event_hash: "different" },
      }),
      update: async () => null,
    }),
    (error: unknown) => error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
  await assert.rejects(
    () => ingestPluginJobReport(event({
      metadata: { run_id: "refresh-version-2", plugin_version: "2.0.0" },
    }), store),
    /插件版本/
  );
  await assert.rejects(
    () => ingestPluginJobReport(event({
      metadata: { run_id: "refresh-en-profile", profile_id: "en-default" },
    }), store),
    /未绑定/
  );
});

test("job report route authenticates, persists valid events, and maps errors safely", async () => {
  const previousToken = process.env.KERKERKER_JOB_REPORT_TOKEN;
  process.env.KERKERKER_JOB_REPORT_TOKEN = reportToken;
  try {
    const store = makeStore();
    const route = createPluginJobReportRouteHandlers(store);
    const request = (body: unknown, token = reportToken) => new NextRequest(
      "http://localhost/api/plugins/jobs/report",
      {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      }
    );

    assert.equal((await route.POST(request(base, "wrong"))).status, 401);
    process.env.KERKERKER_JOB_REPORT_TOKEN = "short-secret";
    assert.equal((await route.POST(request(base))).status, 401);
    process.env.KERKERKER_JOB_REPORT_TOKEN = reportToken;
    assert.equal((await route.POST(new NextRequest(
      "http://localhost/api/plugins/jobs/report",
      {
        method: "POST",
        body: JSON.stringify(base),
        headers: { authorization: `Bearer ${reportToken}` },
      }
    ))).status, 415);
    assert.equal((await route.POST(new NextRequest(
      "http://localhost/api/plugins/jobs/report",
      {
        method: "POST",
        body: new Uint8Array([0xff]),
        headers: {
          authorization: `Bearer ${reportToken}`,
          "content-type": "application/json",
        },
      }
    ))).status, 400);
    const malformed = await route.POST(request('{"uri":"mongodb://user:secret@example.invalid'));
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).message, "任务事件 JSON 无效");
    assert.equal((await route.POST(request("x".repeat(64 * 1024 + 1)))).status, 413);

    const invalidSource = await route.POST(request({
      ...base,
      event_id: "refresh-version-2:0",
      metadata: {
        ...base.metadata,
        run_id: "refresh-version-2",
        plugin_version: "2.0.0",
      },
    }));
    assert.equal(invalidSource.status, 400);
    assert.equal((await invalidSource.json()).message, "任务事件来源无效");

    const accepted = await route.POST(request(base));
    assert.equal(accepted.status, 200);
    assert.deepEqual((await accepted.json()).data, {
      run_id: "refresh-1",
      status: "running",
      revision: 0,
    });

    const conflict = await route.POST(request({
      ...base,
      progress: { ...base.progress, total: 11 },
    }));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).message, "任务事件冲突或无法应用");

    const brokenRoute = createPluginJobReportRouteHandlers({
      get: async () => null,
      create: async () => { throw new RangeError("mongodb://user:secret@example.invalid/jobs"); },
      update: async () => null,
    });
    const failed = await brokenRoute.POST(request(base));
    const failedBody = await failed.json();
    assert.equal(failed.status, 500);
    assert.equal(failedBody.message, "接收插件任务事件失败");
    assert.doesNotMatch(JSON.stringify(failedBody), /user:secret/);
  } finally {
    if (previousToken === undefined) delete process.env.KERKERKER_JOB_REPORT_TOKEN;
    else process.env.KERKERKER_JOB_REPORT_TOKEN = previousToken;
  }
});
