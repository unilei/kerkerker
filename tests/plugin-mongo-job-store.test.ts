import assert from "node:assert/strict";
import test from "node:test";
import { MongoPluginJobStore } from "@/lib/plugins/mongo-job-store";
import {
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobRun,
} from "@/lib/plugins/job-runner";
import { createPluginJobEventRecord } from "@/lib/plugins/job-events";

type RawRun = PluginJobRun & { _id?: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeCollection {
  private readonly documents: RawRun[] = [];

  async findOne(filter: Record<string, unknown>): Promise<RawRun | null> {
    return clone(this.documents.find((document) =>
      Object.entries(filter).every(([key, value]) => document[key as keyof RawRun] === value)
    ) || null);
  }

  async insertOne(document: RawRun): Promise<void> {
    if (this.documents.some((item) => item.run_id === document.run_id || item.idempotency_key === document.idempotency_key)) {
      const error = new Error("duplicate key") as Error & { code: number };
      error.code = 11000;
      throw error;
    }
    this.documents.push(clone(document));
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: { $set: RawRun; $unset?: Record<string, ""> }
  ): Promise<RawRun | null> {
    const index = this.documents.findIndex((document) =>
      Object.entries(filter).every(([key, value]) => document[key as keyof RawRun] === value)
    );
    if (index < 0) return null;
    const next = { ...this.documents[index], ...clone(update.$set) };
    for (const key of Object.keys(update.$unset || {})) delete next[key as keyof RawRun];
    this.documents[index] = next;
    return clone(next);
  }

  find(filter: Record<string, unknown>) {
    let selected = this.documents.filter((document) =>
      Object.entries(filter).every(([key, value]) => document[key as keyof RawRun] === value)
    );
    const cursor = {
      sort: () => {
        selected = [...selected].sort((left, right) => right.created_at.localeCompare(left.created_at));
        return cursor;
      },
      limit: (limit: number) => {
        selected = selected.slice(0, limit);
        return cursor;
      },
      toArray: async () => clone(selected),
    };
    return cursor;
  }
}

function run(overrides: Partial<PluginJobRun> = {}): PluginJobRun {
  return {
    run_id: "run-1",
    plugin_id: "example.plugin",
    plugin_version: "1.0.0",
    profile_id: "cn-default",
    profile: "cn-default",
    config_version: "config-1",
    actor: { type: "system", id: "test" },
    idempotency_key: "job:1",
    status: "queued",
    attempt: 0,
    retry_policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
    cancel_requested: false,
    progress: { total: 0, processed: 0, created: 0, failed: 0, skipped: 0 },
    metadata: {},
    revision: 0,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

test("Mongo job store uses idempotency and revision compare-and-swap", async () => {
  const collection = new FakeCollection();
  const store = new MongoPluginJobStore(collection as never);
  const first = run();
  assert.deepEqual(await store.create(first), first);
  assert.deepEqual(await store.create({ ...first, run_id: "different" }), first);

  await assert.rejects(
    () => store.create({ ...first, plugin_version: "2.0.0" }),
    (error: unknown) => error instanceof PluginJobError && error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );

  const updated = await store.update(first.run_id, 0, (current) => ({
    ...current,
    revision: current.revision + 1,
    status: "running",
    updated_at: "2026-08-21T00:00:01.000Z",
  }));
  assert.equal(updated?.status, "running");
  assert.equal(updated?.revision, 1);
  assert.equal(await store.update(first.run_id, 0, (current) => current), null);
});

test("Mongo job store lists by status without exposing Mongo identity", async () => {
  const collection = new FakeCollection();
  const store = new MongoPluginJobStore(collection as never);
  await store.create(run());
  await store.create(run({
    run_id: "run-2",
    idempotency_key: "job:2",
    status: "failed",
    created_at: "2026-08-21T00:01:00.000Z",
  }));
  const failed = await store.list({ status: "failed" });
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.run_id, "run-2");
  assert.equal("_id" in (failed[0] || {}), false);
});

test("Mongo job store preserves and atomically clears a pending event receipt", async () => {
  const collection = new FakeCollection();
  const store = new MongoPluginJobStore(collection as never);
  const pending = createPluginJobEventRecord({
    event: {
      schema: "kerkerker.plugin-job.v1",
      event_id: "run-1:0",
      sequence: 0,
      kind: "started",
      occurred_at: "2026-08-21T00:00:00Z",
      metadata: {
        run_id: "run-1",
        plugin_id: "example.plugin",
        plugin_version: "1.0.0",
        profile_id: "cn-default",
        config_version: "config-1",
        actor: "test",
        attempt: 1,
      },
      status: "running",
      progress: { total: 0, processed: 0, created: 0, failed: 0, skipped: 0 },
    },
    eventHash: "a".repeat(64),
    receivedAt: "2026-08-21T00:00:00.000Z",
    expiresAt: new Date("2026-09-20T00:00:00.000Z"),
  });
  await store.create(run({
    status: "running",
    attempt: 1,
    pending_event_receipt: pending,
  }));

  const loaded = await store.get("run-1");
  assert.equal(loaded?.pending_event_receipt?.event_id, "run-1:0");
  assert.ok(loaded?.pending_event_receipt?.expires_at instanceof Date);

  const cleared = await store.update("run-1", 0, (current) => ({
    ...current,
    pending_event_receipt: undefined,
    revision: 1,
  }));
  assert.equal(cleared?.pending_event_receipt, undefined);
  assert.equal((await store.get("run-1"))?.pending_event_receipt, undefined);
});
