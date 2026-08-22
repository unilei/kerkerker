import assert from "node:assert/strict";
import test from "node:test";

import {
  Decimal128,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
} from "mongodb";

import type { PluginJobRun } from "@/lib/plugins/job-runner";
import { createMongoPluginJobStore } from "@/lib/plugins/mongo-job-store";

const mongoUri = process.env.PLUGIN_JOB_REAL_MONGO_URI;

function run(index: number, overrides: Partial<PluginJobRun> = {}): PluginJobRun {
  const createdAt = new Date(Date.parse("2026-08-21T00:00:00.000Z") + index).toISOString();
  return {
    run_id: `real-run-${index}`,
    job_id: "content.catalog.sync",
    control_mode: "host",
    plugin_id: "example.plugin",
    plugin_version: "1.0.0",
    profile_id: "cn-default",
    profile: "cn-default",
    config_version: "config-1",
    actor: { type: "system", id: "integration-test" },
    idempotency_key: `real-job-${index}`,
    status: "queued",
    attempt: 0,
    retry_policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
    lease_fence: 0,
    cancel_requested: false,
    progress: { total: 0, processed: 0, created: 0, failed: 0, skipped: 0 },
    metadata: {},
    revision: 0,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

test("real Mongo atomically claims and fences plugin jobs", { skip: !mongoUri }, async () => {
  assert.ok(mongoUri);
  const client = new MongoClient(mongoUri);
  const databaseName = `kerkerker_plugin_claim_${process.pid}_${Date.now()}`;
  try {
    await client.connect();
    const db = client.db(databaseName);
    const collection = db.collection("plugin_jobs");
    await collection.createIndex({ run_id: 1 }, { unique: true });
    await collection.createIndex({ idempotency_key: 1 }, { unique: true });
    const store = createMongoPluginJobStore(db);

    const legacyHostRun = Object.fromEntries(
      Object.entries(run(0)).filter(([key]) =>
        !["job_id", "control_mode", "lease_fence"].includes(key))
    );
    await collection.insertOne(legacyHostRun);
    await store.create(run(1));
    await store.create(run(2, {
      control_mode: "external-report",
      job_id: "content.refresh.daily",
    }));
    await store.create(run(3, {
      status: "retry_waiting",
      attempt: 1,
      next_retry_at: "2999-01-01T00:00:00.000Z",
    }));
    await store.create(run(4, { cancel_requested: true }));

    const competingClaims = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.claimNext({
        owner: "worker-shared",
        token: `single-token-${index}`,
        now: "2026-08-21T00:00:00.000Z",
        leaseTtlMs: 60_000,
      }))
    );
    const winner = competingClaims.filter((value): value is PluginJobRun => Boolean(value));
    assert.equal(winner.length, 1);
    assert.equal(winner[0].run_id, "real-run-1");
    assert.equal(winner[0].lease_fence, 1);
    assert.equal((await store.get("real-run-0"))?.job_id, "legacy.unspecified");
    assert.equal((await store.get("real-run-0"))?.attempt, 0);
    assert.equal((await store.get("real-run-2"))?.attempt, 0);
    assert.equal((await store.get("real-run-3"))?.attempt, 1);
    assert.equal((await store.get("real-run-4"))?.attempt, 0);

    await collection.deleteMany({});
    await collection.insertMany([
      {
        ...run(20),
        status: "retry_waiting",
        attempt: 1,
      },
      {
        ...run(21),
        status: "retry_waiting",
        attempt: 1,
        next_retry_at: null,
      },
      {
        ...run(22),
        status: "retry_waiting",
        attempt: 1,
        next_retry_at: "not-a-date",
      },
      {
        ...run(24),
        status: "retry_waiting",
        attempt: 1,
        next_retry_at: 0,
      },
      {
        ...run(25),
        status: "retry_waiting",
        attempt: 1,
        next_retry_at: new ObjectId("000000000000000000000000"),
      },
      {
        ...run(26),
        status: "retry_waiting",
        attempt: 1,
        next_retry_at: Long.fromNumber(0),
      },
      {
        ...run(27),
        status: "retry_waiting",
        attempt: 1,
        next_retry_at: Decimal128.fromString("0"),
      },
      {
        ...run(28),
        status: "retry_waiting",
        attempt: 1,
        next_retry_at: Timestamp.fromNumber(0),
      },
      {
        ...run(23),
        status: "retry_waiting",
        attempt: 1,
        next_retry_at: new Date("2000-01-01T00:00:00.000Z"),
      },
    ]);
    const bsonRetry = await store.claimNext({
      owner: "worker-bson-retry",
      token: "bson-retry-token",
      now: "2999-01-01T00:00:00.000Z",
      leaseTtlMs: 60_000,
    });
    assert.equal(bsonRetry?.run_id, "real-run-23");
    assert.equal(await store.claimNext({
      owner: "worker-invalid-retry",
      token: "invalid-retry-token",
      now: "2999-01-01T00:00:00.000Z",
      leaseTtlMs: 60_000,
    }), null);

    await collection.deleteMany({});
    const rawLease = {
      owner: "worker-raw",
      token: "raw-token",
      fence: 1,
      acquired_at: "2026-08-21T00:00:00.000Z",
      heartbeat_at: "2026-08-21T00:00:00.000Z",
    };
    await collection.insertMany([
      {
        ...run(30),
        status: "running",
        attempt: 1,
        lease_fence: 1,
        lease: rawLease,
      },
      {
        ...run(31),
        status: "running",
        attempt: 1,
        lease_fence: 1,
        lease: { ...rawLease, expires_at: null },
      },
      {
        ...run(32),
        status: "running",
        attempt: 1,
        lease_fence: 1,
        lease: { ...rawLease, expires_at: "not-a-date" },
      },
      {
        ...run(33),
        status: "running",
        attempt: 1,
        lease_fence: 1,
        lease: {
          ...rawLease,
          expires_at: new Date("2000-01-01T00:00:00.000Z"),
        },
      },
      ...[
        new ObjectId("000000000000000000000000"),
        Long.fromNumber(0),
        Decimal128.fromString("0"),
        Timestamp.fromNumber(0),
      ].map((expiresAt, index) => ({
        ...run(35 + index),
        status: "running",
        attempt: 1,
        lease_fence: 1,
        lease: { ...rawLease, expires_at: expiresAt },
      })),
    ]);
    const bsonExpiredLease = await store.claimNext({
      owner: "worker-bson-lease",
      token: "bson-lease-token",
      now: "2999-01-01T00:00:00.000Z",
      leaseTtlMs: 60_000,
    });
    assert.equal(bsonExpiredLease?.run_id, "real-run-33");
    assert.equal(await store.claimNext({
      owner: "worker-invalid-lease",
      token: "invalid-lease-token",
      now: "2999-01-01T00:00:00.000Z",
      leaseTtlMs: 60_000,
    }), null);
    const invalidLeaseRunIds = [
      "real-run-30",
      "real-run-31",
      "real-run-32",
      "real-run-35",
      "real-run-36",
      "real-run-37",
      "real-run-38",
    ];
    for (const runId of invalidLeaseRunIds) {
      assert.equal(await store.renewLease(
        runId,
        0,
        { owner: "worker-raw", token: "raw-token", fence: 1 },
        60_000,
        "2000-01-01T00:00:00.000Z"
      ), null);
      assert.equal(await store.updateWithLease(
        runId,
        0,
        { owner: "worker-raw", token: "raw-token", fence: 1 },
        "2000-01-01T00:00:00.000Z",
        (current) => ({ ...current, revision: current.revision + 1 })
      ), null);
    }
    await collection.updateMany(
      { run_id: { $in: invalidLeaseRunIds } },
      { $set: { cancel_requested: true } }
    );
    assert.equal(
      await store.recoverExpiredLeases("2999-01-01T00:00:00.000Z"),
      0
    );
    for (const runId of invalidLeaseRunIds) {
      assert.equal((await store.get(runId))?.status, "running");
    }

    await collection.deleteMany({});
    await collection.insertOne({
      ...run(34),
      status: "running",
      attempt: 1,
      lease_fence: 1,
      lease: {
        ...rawLease,
        expires_at: new Date("2999-01-01T00:00:00.000Z"),
      },
    });
    const bsonActiveLease = await store.renewLease(
      "real-run-34",
      0,
      { owner: "worker-raw", token: "raw-token", fence: 1 },
      60_000,
      "2000-01-01T00:00:00.000Z"
    );
    assert.equal(bsonActiveLease?.revision, 1);
    assert.equal(typeof bsonActiveLease?.lease?.expires_at, "string");

    await collection.deleteMany({});
    await store.create(run(10));
    const first = await store.claimNext({
      owner: "worker-stable",
      token: "first-token",
      now: "2026-08-21T00:00:00.000Z",
      leaseTtlMs: 60_000,
    });
    assert.ok(first?.lease);
    assert.equal(await store.claimNext({
      owner: "worker-fast-clock",
      token: "clock-skew-token",
      now: "2999-01-01T00:00:00.000Z",
      leaseTtlMs: 60_000,
    }), null);
    await collection.updateOne(
      { run_id: first.run_id },
      { $set: { "lease.expires_at": "2000-01-01T00:00:00.000Z" } }
    );
    const takeover = await store.claimNext({
      owner: "worker-stable",
      token: "takeover-token",
      now: "2026-08-21T00:02:00.000Z",
      leaseTtlMs: 60_000,
    });
    assert.ok(takeover?.lease);
    assert.equal(takeover.lease.fence, 2);
    assert.notEqual(takeover.lease.token, first.lease.token);
    assert.equal(await store.updateWithLease(
      takeover.run_id,
      takeover.revision,
      { owner: first.lease.owner, token: first.lease.token, fence: first.lease.fence },
      "2026-08-21T00:02:30.000Z",
      (current) => ({ ...current, revision: current.revision + 1 })
    ), null);
    const fencedUpdate = await store.updateWithLease(
      takeover.run_id,
      takeover.revision,
      {
        owner: takeover.lease.owner,
        token: takeover.lease.token,
        fence: takeover.lease.fence,
      },
      "2026-08-21T00:02:30.000Z",
      (current) => ({
        ...current,
        progress: { ...current.progress, total: 1 },
        revision: current.revision + 1,
      })
    );
    assert.equal(fencedUpdate?.progress.total, 1);

    await collection.deleteMany({});
    await Promise.all(Array.from({ length: 16 }, (_, index) =>
      store.create(run(100 + index))));
    const batchClaims = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      store.claimNext({
        owner: `worker-${index}`,
        token: `batch-token-${index}`,
        now: "2026-08-21T00:00:00.000Z",
        leaseTtlMs: 300_000,
      })));
    const claimedIds = batchClaims
      .filter((value): value is PluginJobRun => Boolean(value))
      .map((value) => value.run_id);
    assert.equal(claimedIds.length, 16);
    assert.equal(new Set(claimedIds).size, 16);

    await collection.deleteMany({});
    const expiredLease = {
      owner: "worker-old",
      token: "expired-token",
      fence: 1,
      acquired_at: "2026-08-21T00:00:00.000Z",
      heartbeat_at: "2026-08-21T00:00:00.000Z",
      expires_at: "2000-01-01T00:00:00.000Z",
    };
    await store.create(run(200, {
      status: "running",
      attempt: 1,
      lease_fence: 1,
      lease: expiredLease,
      cancel_requested: true,
    }));
    await store.create(run(201, {
      status: "running",
      attempt: 3,
      lease_fence: 1,
      lease: expiredLease,
    }));
    assert.equal(
      await store.recoverExpiredLeases("2026-08-21T00:02:00.000Z"),
      2
    );
    assert.equal((await store.get("real-run-200"))?.status, "cancelled");
    assert.equal((await store.get("real-run-201"))?.status, "failed");
  } finally {
    await client.db(databaseName).dropDatabase().catch(() => undefined);
    await client.close();
  }
});
