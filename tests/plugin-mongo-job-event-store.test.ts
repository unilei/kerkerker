import assert from "node:assert/strict";
import test from "node:test";

import type { PluginJobEvent } from "@/packages/kerkerker-plugin-contract/src/index";
import {
  createPluginJobEventRecord,
  redactPluginJobEventText,
  type PluginJobEventRecord,
} from "@/lib/plugins/job-events";
import { MongoPluginJobEventStore } from "@/lib/plugins/mongo-job-event-store";
import {
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
} from "@/lib/plugins/job-runner";

type RawEvent = PluginJobEventRecord & { _id?: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matches(document: RawEvent, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key as keyof RawEvent];
    if (
      expected &&
      typeof expected === "object" &&
      "$gt" in (expected as Record<string, unknown>)
    ) {
      return Number(actual) > Number((expected as { $gt: number }).$gt);
    }
    return actual === expected;
  });
}

class FakeCollection {
  private readonly documents: RawEvent[] = [];

  async findOne(filter: Record<string, unknown>): Promise<RawEvent | null> {
    return clone(this.documents.find((document) => matches(document, filter)) || null);
  }

  async insertOne(document: RawEvent): Promise<void> {
    if (
      this.documents.some(
        (item) =>
          item.event_id === document.event_id ||
          (item.run_id === document.run_id && item.sequence === document.sequence)
      )
    ) {
      const error = new Error("duplicate key") as Error & { code: number };
      error.code = 11000;
      throw error;
    }
    this.documents.push(clone(document));
  }

  find(filter: Record<string, unknown>) {
    let selected = this.documents.filter((document) => matches(document, filter));
    const cursor = {
      sort: () => {
        selected = [...selected].sort((left, right) => left.sequence - right.sequence);
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

function event(sequence = 0, overrides: Partial<PluginJobEvent> = {}): PluginJobEvent {
  const runId = overrides.metadata?.run_id || "refresh-1";
  return {
    schema: "kerkerker.plugin-job.v1",
    event_id: `${runId}:${sequence}`,
    sequence,
    kind: sequence === 0 ? "started" : "progress",
    occurred_at: `2026-08-22T00:00:0${sequence}Z`,
    metadata: {
      run_id: runId,
      plugin_id: "kerkerker.douban-content",
      plugin_version: "1.0.0",
      profile_id: "cn-default",
      config_version: "runtime",
      actor: "system/refresh",
      attempt: 1,
      ...overrides.metadata,
    },
    status: "running",
    progress: {
      total: 10,
      processed: sequence,
      created: sequence,
      failed: 0,
      skipped: 0,
    },
    ...overrides,
  };
}

function appendInput(sequence = 0, overrides: Partial<PluginJobEvent> = {}) {
  return createPluginJobEventRecord({
    event: event(sequence, overrides),
    eventHash: String(sequence).repeat(64),
    receivedAt: `2026-08-22T00:01:0${sequence}.000Z`,
    expiresAt: new Date("2026-09-21T00:00:00.000Z"),
  });
}

test("Mongo job event store appends exact receipts idempotently", async () => {
  const store = new MongoPluginJobEventStore(new FakeCollection() as never);
  const first = await store.append(appendInput());
  const replay = await store.append({
    ...appendInput(),
    received_at: "2026-08-22T01:00:00.000Z",
  });

  assert.equal(first.event_id, "refresh-1:0");
  assert.equal(replay.received_at, first.received_at);
  assert.notEqual(replay, first);

  await assert.rejects(
    () => store.append({ ...appendInput(), event_hash: "f".repeat(64) }),
    (error: unknown) =>
      error instanceof PluginJobError &&
      error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
});

test("Mongo job event store protects run sequence and lists forward pages", async () => {
  const store = new MongoPluginJobEventStore(new FakeCollection() as never);
  await store.append(appendInput(0));
  await store.append(appendInput(2));
  await store.append(appendInput(1));

  assert.deepEqual(
    (await store.list({ runId: "refresh-1", afterSequence: 0, limit: 2 })).map(
      (item) => item.sequence
    ),
    [1, 2]
  );

  await assert.rejects(
    () =>
      store.append({
        ...appendInput(1),
        event_id: "different:1",
      }),
    (error: unknown) =>
      error instanceof PluginJobError &&
      error.code === PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT
  );
});

test("Mongo job event store redacts sensitive URL parameters", async () => {
  const store = new MongoPluginJobEventStore(new FakeCollection() as never);
  const stored = await store.append(
    appendInput(1, {
      kind: "finished",
      status: "failed",
      error: {
        code: "UPSTREAM_ERROR",
        message: "https://example.com/fail?token=plain-secret&item=1#debug",
      },
    })
  );

  assert.doesNotMatch(stored.error?.message || "", /plain-secret|#debug/);
  assert.match(stored.error?.message || "", /item=1/);
});

test("job event text redaction removes embedded DSN, auth, JWT, and assignments", () => {
  const jwt = `${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
  const sanitized = redactPluginJobEventText(
    "request https://alice:hunter2@example.invalid/fail?token=url-secret&pass=url-pass&pwd=url-pwd&item=1 " +
      "mongodb://dbuser:dbpass@mongo:27017/db?authSource=admin " +
      "amqp://queue-user:queue-pass@broker:5672/vhost\n" +
      "Authorization: Bearer bearer-secret Basic YmFzaWMtc2VjcmV0\n" +
      "Authorization=ApiKey apikey-secret scope=admin\n" +
      "Proxy-Authorization: Digest username=proxy-user password=proxy-pass\n" +
      "DATABASE_PASSWORD=hunter2 KERKERKER_JOB_REPORT_TOKEN=report-secret\n" +
      'payload={"token":"json-secret"}\n' +
      String.raw`escaped={\"client_secret\":\"escaped-json-secret\"}` +
      ` pass=plain-pass pwd=plain-pwd api_key=plain-key jwt=${jwt} failed`
  );

  assert.doesNotMatch(
    sanitized,
    /alice|hunter2|url-secret|url-pass|url-pwd|dbuser|dbpass|admin|queue-user|queue-pass|bearer-secret|YmFzaWM|apikey-secret|proxy-user|proxy-pass|report-secret|json-secret|escaped-json-secret|plain-pass|plain-pwd|plain-key|aaaaaaaaaaaa/
  );
  assert.match(sanitized, /item=1/);

  const invalidCodeEvent = event(1, {
      kind: "finished",
      status: "failed",
      error: { code: "token=must-not-leak", message: "failed" },
  });
  const record = createPluginJobEventRecord({
    event: invalidCodeEvent,
    eventHash: "f".repeat(64),
    receivedAt: "2026-08-22T00:01:01.000Z",
    expiresAt: new Date("2026-09-21T00:00:00.000Z"),
  });
  assert.equal(record.error?.code, "UNCLASSIFIED_ERROR");
});
