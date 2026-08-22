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
const REMOVE = Symbol("remove");

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeCollection {
  private readonly documents: RawRun[] = [];
  private serverNow = "2026-08-21T00:00:00.000Z";

  setServerNow(value: string): void {
    this.serverNow = value;
  }

  private field(document: RawRun, path: string): unknown {
    return path.split(".").reduce<unknown>((value, key) =>
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined, document);
  }

  private expression(document: RawRun, value: unknown): unknown {
    if (value === "$$NOW") return new Date(this.serverNow);
    if (value === "$$REMOVE") return REMOVE;
    if (typeof value === "string" && value.startsWith("$")) {
      return this.field(document, value.slice(1));
    }
    if (!value || typeof value !== "object" || value instanceof Date) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.expression(document, item));
    }
    const expression = value as Record<string, unknown>;
    if ("$literal" in expression) return clone(expression.$literal);
    if ("$ifNull" in expression) {
      const [candidate, fallback] = expression.$ifNull as unknown[];
      return this.expression(document, candidate) ?? this.expression(document, fallback);
    }
    if ("$add" in expression) {
      return (expression.$add as unknown[]).reduce<number>(
        (sum, item) => sum + Number(this.expression(document, item)),
        0
      );
    }
    if ("$dateAdd" in expression) {
      const dateAdd = expression.$dateAdd as { startDate: unknown; amount: unknown };
      const start = this.expression(document, dateAdd.startDate);
      return new Date(new Date(start as Date | string).getTime() + Number(dateAdd.amount));
    }
    if ("$dateToString" in expression) {
      const input = expression.$dateToString as { date: unknown };
      return new Date(this.expression(document, input.date) as Date | string).toISOString();
    }
    if ("$convert" in expression) {
      const input = expression.$convert as {
        input: unknown;
        to: string;
        onError: unknown;
        onNull: unknown;
      };
      const candidate = this.expression(document, input.input);
      if (candidate === null || candidate === undefined) {
        return this.expression(document, input.onNull);
      }
      if (input.to === "date") {
        const converted = new Date(candidate as Date | string | number);
        return Number.isFinite(converted.getTime())
          ? converted
          : this.expression(document, input.onError);
      }
      return this.expression(document, input.onError);
    }
    if ("$type" in expression) {
      const candidate = this.expression(document, expression.$type);
      if (candidate === undefined) return "missing";
      if (candidate === null) return "null";
      if (candidate instanceof Date) return "date";
      if (typeof candidate === "number") return "double";
      return typeof candidate;
    }
    if ("$in" in expression) {
      const [candidate, choices] = expression.$in as unknown[];
      return (this.expression(document, choices) as unknown[]).includes(
        this.expression(document, candidate)
      );
    }
    if ("$cond" in expression) {
      const [condition, whenTrue, whenFalse] = expression.$cond as unknown[];
      return this.expression(document, condition)
        ? this.expression(document, whenTrue)
        : this.expression(document, whenFalse);
    }
    for (const operator of ["$eq", "$ne", "$lt", "$lte", "$gt", "$gte"] as const) {
      if (!(operator in expression)) continue;
      const [leftValue, rightValue] = expression[operator] as unknown[];
      const left = this.expression(document, leftValue) as string | number;
      const right = this.expression(document, rightValue) as string | number;
      if (operator === "$eq") return left === right;
      if (operator === "$ne") return left !== right;
      if (operator === "$lt") return left < right;
      if (operator === "$lte") return left <= right;
      if (operator === "$gt") return left > right;
      return left >= right;
    }
    if ("$and" in expression) {
      return (expression.$and as unknown[]).every((item) => this.expression(document, item));
    }
    if ("$or" in expression) {
      return (expression.$or as unknown[]).some((item) => this.expression(document, item));
    }
    return Object.fromEntries(
      Object.entries(expression).map(([key, item]) => [key, this.expression(document, item)])
    );
  }

  private assign(document: RawRun, path: string, value: unknown): void {
    const parts = path.split(".");
    let target = document as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== "object") target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (value === REMOVE) delete target[key];
    else target[key] = clone(value);
  }

  private applyPipeline(document: RawRun, pipeline: Record<string, unknown>[]): RawRun {
    let next = clone(document);
    for (const stage of pipeline) {
      const set = stage.$set as Record<string, unknown> | undefined;
      if (!set) continue;
      const values = Object.entries(set).map(([path, value]) => [
        path,
        this.expression(next, value),
      ] as const);
      const updated = clone(next);
      for (const [path, value] of values) this.assign(updated, path, value);
      next = updated;
    }
    return next;
  }

  private matches(document: RawRun, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, expected]) => {
      if (key === "$or") {
        return (expected as Record<string, unknown>[]).some((item) =>
          this.matches(document, item));
      }
      if (key === "$and") {
        return (expected as Record<string, unknown>[]).every((item) =>
          this.matches(document, item));
      }
      if (key === "$expr") {
        return Boolean(this.expression(document, expected));
      }
      const actual = this.field(document, key);
      if (expected && typeof expected === "object") {
        if ("$exists" in expected) {
          return (actual !== undefined) === Boolean(
            (expected as { $exists: unknown }).$exists
          );
        }
        if ("$ne" in expected) {
          return actual !== (expected as { $ne: unknown }).$ne;
        }
        if ("$lte" in expected) {
          return String(actual) <= String((expected as { $lte: unknown }).$lte);
        }
        if ("$gt" in expected) {
          return String(actual) > String((expected as { $gt: unknown }).$gt);
        }
      }
      return actual === expected;
    });
  }

  async findOne(filter: Record<string, unknown>): Promise<RawRun | null> {
    return clone(this.documents.find((document) => this.matches(document, filter)) || null);
  }

  async insertOne(document: RawRun): Promise<void> {
    if (this.documents.some((item) => item.run_id === document.run_id || item.idempotency_key === document.idempotency_key)) {
      const error = new Error("duplicate key") as Error & { code: number };
      error.code = 11000;
      throw error;
    }
    this.documents.push(clone(document));
  }

  async updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>[]
  ): Promise<{ modifiedCount: number }> {
    let modifiedCount = 0;
    for (let index = 0; index < this.documents.length; index += 1) {
      const current = this.documents[index];
      if (!this.matches(current, filter)) continue;
      this.documents[index] = this.applyPipeline(current, update);
      modifiedCount += 1;
    }
    return { modifiedCount };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: { $set: RawRun; $unset?: Record<string, ""> } | Record<string, unknown>[],
    options: { sort?: Record<string, 1 | -1> } = {}
  ): Promise<RawRun | null> {
    const indexes = this.documents
      .map((document, index) => ({ document, index }))
      .filter(({ document }) => this.matches(document, filter))
      .sort((left, right) => {
        for (const [field, direction] of Object.entries(options.sort || {})) {
          const compared = String(this.field(left.document, field)).localeCompare(
            String(this.field(right.document, field))
          );
          if (compared !== 0) return compared * direction;
        }
        return 0;
      });
    const index = indexes[0]?.index ?? -1;
    if (index < 0) return null;
    if (Array.isArray(update)) {
      const next = this.applyPipeline(this.documents[index], update);
      this.documents[index] = clone(next);
      return clone(next);
    }
    const next = { ...this.documents[index], ...clone(update.$set) };
    for (const key of Object.keys(update.$unset || {})) delete next[key as keyof RawRun];
    this.documents[index] = next;
    return clone(next);
  }

  find(filter: Record<string, unknown>) {
    let selected = this.documents.filter((document) => this.matches(document, filter));
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
    job_id: "content.catalog.sync",
    control_mode: "host",
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
    lease_fence: 0,
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

test("Mongo job store atomically claims only eligible host work", async () => {
  const collection = new FakeCollection();
  const store = new MongoPluginJobStore(collection as never);
  await store.create(run());
  await store.create(run({
    run_id: "external-run",
    idempotency_key: "job:external",
    job_id: "content.refresh.daily",
    control_mode: "external-report",
    status: "running",
    attempt: 1,
  }));
  await store.create(run({
    run_id: "future-run",
    idempotency_key: "job:future",
    status: "retry_waiting",
    attempt: 1,
    next_retry_at: "2026-08-21T01:00:00.000Z",
  }));
  await store.create(run({
    run_id: "cancelled-run",
    idempotency_key: "job:cancelled",
    cancel_requested: true,
  }));
  await store.create(run({
    run_id: "shadow-run",
    idempotency_key: "job:shadow",
    host_claimable: false,
  }));
  await store.create(run({
    run_id: "malformed-claimable-run",
    idempotency_key: "job:malformed-claimable",
    host_claimable: "yes" as unknown as boolean,
  }));

  const claims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    store.claimNext({
      owner: "worker-shared",
      token: `token-${index}`,
      now: "2026-08-21T00:00:00.000Z",
      leaseTtlMs: 60_000,
    })));
  const winners = claims.filter((claimed): claimed is PluginJobRun => Boolean(claimed));
  assert.equal(winners.length, 1);
  assert.equal(winners[0].run_id, "run-1");
  assert.equal(winners[0].attempt, 1);
  assert.equal(winners[0].revision, 1);
  assert.equal(winners[0].lease_fence, 1);
  assert.equal(winners[0].lease?.fence, 1);
  assert.equal(await store.claimNext({
    owner: "worker-next",
    token: "token-next",
    now: "2026-08-21T00:00:00.000Z",
    leaseTtlMs: 60_000,
  }), null);
});

test("Mongo job store ignores worker clock skew for claim and heartbeat expiry", async () => {
  const collection = new FakeCollection();
  const store = new MongoPluginJobStore(collection as never);
  await store.create(run());
  const first = await store.claimNext({
    owner: "worker-a",
    token: "token-a",
    now: "2999-01-01T00:00:00.000Z",
    leaseTtlMs: 60_000,
  });
  assert.ok(first?.lease);
  assert.equal(first.lease.acquired_at, "2026-08-21T00:00:00.000Z");
  assert.equal(first.lease.expires_at, "2026-08-21T00:01:00.000Z");
  assert.equal(await store.claimNext({
    owner: "worker-fast-clock",
    token: "token-fast",
    now: "2999-01-01T00:01:00.000Z",
    leaseTtlMs: 60_000,
  }), null);

  collection.setServerNow("2026-08-21T00:00:30.000Z");
  const renewed = await store.renewLease(
    first.run_id,
    first.revision,
    {
      owner: first.lease.owner,
      token: first.lease.token,
      fence: first.lease.fence,
    },
    120_000,
    "2999-01-01T00:02:00.000Z"
  );
  assert.equal(renewed?.lease?.heartbeat_at, "2026-08-21T00:00:30.000Z");
  assert.equal(renewed?.lease?.expires_at, "2026-08-21T00:02:30.000Z");
});

test("Mongo job store fails closed on invalid timestamps and accepts BSON dates", async () => {
  const retryCollection = new FakeCollection();
  const retryStore = new MongoPluginJobStore(retryCollection as never);
  await retryCollection.insertOne(run({
    run_id: "retry-missing",
    idempotency_key: "job:retry-missing",
    status: "retry_waiting",
    attempt: 1,
  }));
  await retryCollection.insertOne({
    ...run({
      run_id: "retry-null",
      idempotency_key: "job:retry-null",
      status: "retry_waiting",
      attempt: 1,
    }),
    next_retry_at: null,
  } as unknown as RawRun);
  await retryCollection.insertOne(run({
    run_id: "retry-malformed",
    idempotency_key: "job:retry-malformed",
    status: "retry_waiting",
    attempt: 1,
    next_retry_at: "not-a-date",
  }));
  await retryCollection.insertOne({
    ...run({
      run_id: "retry-number",
      idempotency_key: "job:retry-number",
      status: "retry_waiting",
      attempt: 1,
    }),
    next_retry_at: 0,
  } as unknown as RawRun);
  await retryCollection.insertOne({
    ...run({
      run_id: "retry-bson",
      idempotency_key: "job:retry-bson",
      status: "retry_waiting",
      attempt: 1,
    }),
    next_retry_at: new Date("2000-01-01T00:00:00.000Z"),
  } as unknown as RawRun);
  assert.equal((await retryStore.claimNext({
    owner: "worker-retry",
    token: "retry-token",
    now: "2999-01-01T00:00:00.000Z",
    leaseTtlMs: 60_000,
  }))?.run_id, "retry-bson");
  assert.equal(await retryStore.claimNext({
    owner: "worker-retry-invalid",
    token: "retry-invalid-token",
    now: "2999-01-01T00:00:00.000Z",
    leaseTtlMs: 60_000,
  }), null);

  const leaseCollection = new FakeCollection();
  const leaseStore = new MongoPluginJobStore(leaseCollection as never);
  const rawLease = {
    owner: "worker-raw",
    token: "raw-token",
    fence: 1,
    acquired_at: "2026-08-21T00:00:00.000Z",
    heartbeat_at: "2026-08-21T00:00:00.000Z",
  };
  for (const [suffix, expiresAt] of [
    ["missing", undefined],
    ["null", null],
    ["malformed", "not-a-date"],
    ["bson", new Date("2000-01-01T00:00:00.000Z")],
  ] as const) {
    await leaseCollection.insertOne({
      ...run({
        run_id: `lease-${suffix}`,
        idempotency_key: `job:lease-${suffix}`,
        status: "running",
        attempt: 1,
        lease_fence: 1,
      }),
      lease: {
        ...rawLease,
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      },
    } as unknown as RawRun);
  }
  assert.equal((await leaseStore.claimNext({
    owner: "worker-lease",
    token: "lease-token",
    now: "2999-01-01T00:00:00.000Z",
    leaseTtlMs: 60_000,
  }))?.run_id, "lease-bson");
  assert.equal(await leaseStore.claimNext({
    owner: "worker-lease-invalid",
    token: "lease-invalid-token",
    now: "2999-01-01T00:00:00.000Z",
    leaseTtlMs: 60_000,
  }), null);
  assert.equal(await leaseStore.renewLease(
    "lease-malformed",
    0,
    { owner: "worker-raw", token: "raw-token", fence: 1 },
    60_000,
    "2000-01-01T00:00:00.000Z"
  ), null);
  assert.equal(await leaseStore.updateWithLease(
    "lease-malformed",
    0,
    { owner: "worker-raw", token: "raw-token", fence: 1 },
    "2000-01-01T00:00:00.000Z",
    (current) => ({ ...current, revision: current.revision + 1 })
  ), null);
});

test("Mongo job store fences an expired claim even when owner is reused", async () => {
  const collection = new FakeCollection();
  const store = new MongoPluginJobStore(collection as never);
  await store.create(run());
  const first = await store.claimNext({
    owner: "worker-stable",
    token: "token-first",
    now: "2026-08-21T00:00:00.000Z",
    leaseTtlMs: 60_000,
  });
  assert.ok(first?.lease);
  collection.setServerNow("2026-08-21T00:02:00.000Z");
  const second = await store.claimNext({
    owner: "worker-stable",
    token: "token-second",
    now: "2026-08-21T00:02:00.000Z",
    leaseTtlMs: 60_000,
  });
  assert.ok(second?.lease);
  assert.equal(second.lease.fence, 2);
  assert.notEqual(second.lease.token, first.lease.token);

  const stale = await store.updateWithLease(
    second.run_id,
    second.revision,
    { owner: first.lease.owner, token: first.lease.token, fence: first.lease.fence },
    "2026-08-21T00:02:30.000Z",
    (current) => ({ ...current, revision: current.revision + 1 })
  );
  assert.equal(stale, null);

  const current = await store.updateWithLease(
    second.run_id,
    second.revision,
    { owner: second.lease.owner, token: second.lease.token, fence: second.lease.fence },
    "2026-08-21T00:02:30.000Z",
    (run) => ({
      ...run,
      progress: { ...run.progress, total: 1 },
      revision: run.revision + 1,
    })
  );
  assert.equal(current?.progress.total, 1);
});

test("Mongo job store finalizes cancelled and exhausted expired leases", async () => {
  const collection = new FakeCollection();
  const store = new MongoPluginJobStore(collection as never);
  const expiredLease = {
    owner: "worker-old",
    token: "token-old",
    fence: 1,
    acquired_at: "2026-08-21T00:00:00.000Z",
    heartbeat_at: "2026-08-21T00:00:00.000Z",
    expires_at: "2026-08-21T00:01:00.000Z",
  };
  await store.create(run({
    run_id: "cancelled-expired",
    idempotency_key: "job:cancelled-expired",
    status: "running",
    attempt: 1,
    lease_fence: 1,
    lease: expiredLease,
    cancel_requested: true,
  }));
  await store.create(run({
    run_id: "exhausted-expired",
    idempotency_key: "job:exhausted-expired",
    status: "running",
    attempt: 3,
    lease_fence: 1,
    lease: expiredLease,
  }));
  await store.create(run({
    run_id: "reclaimable-expired",
    idempotency_key: "job:reclaimable-expired",
    status: "running",
    attempt: 1,
    lease_fence: 1,
    lease: expiredLease,
  }));

  collection.setServerNow("2026-08-21T00:02:00.000Z");
  assert.equal(
    await store.recoverExpiredLeases("2026-08-21T00:02:00.000Z"),
    2
  );
  assert.equal((await store.get("cancelled-expired"))?.status, "cancelled");
  assert.equal((await store.get("exhausted-expired"))?.status, "failed");
  assert.equal(
    (await store.get("exhausted-expired"))?.error?.code,
    PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED
  );
  assert.equal((await store.get("reclaimable-expired"))?.status, "running");
});
