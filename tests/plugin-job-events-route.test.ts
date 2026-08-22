import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { createPluginJobEventsRouteHandlers } from "@/app/api/plugins/jobs/events/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import type { PluginJobEventRecord } from "@/lib/plugins/job-events";
import type { PluginJobRun } from "@/lib/plugins/job-runner";

const job = {
  run_id: "refresh-1",
  plugin_id: "kerkerker.douban-content",
  plugin_version: "1.0.0",
  profile_id: "cn-default",
  profile: "cn-default",
  config_version: "runtime",
  actor: { type: "system", id: "refresh" },
  idempotency_key: "report:refresh-1",
  status: "running",
  attempt: 1,
  retry_policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  cancel_requested: false,
  progress: { total: 2, processed: 1, created: 1, failed: 0, skipped: 0 },
  metadata: { source: "job-report" },
  revision: 1,
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:01:00.000Z",
} satisfies PluginJobRun;

const events: PluginJobEventRecord[] = [0, 1, 2].map((sequence) => ({
  schema: "kerkerker.plugin-job.v1",
  event_id: `refresh-1:${sequence}`,
  event_hash: String(sequence).repeat(64),
  run_id: "refresh-1",
  sequence,
  kind: sequence === 0 ? "started" : sequence === 2 ? "finished" : "progress",
  occurred_at: `2026-08-22T00:00:0${sequence}Z`,
  received_at: `2026-08-22T00:01:0${sequence}.000Z`,
  metadata: {
    run_id: "refresh-1",
    plugin_id: "kerkerker.douban-content",
    plugin_version: "1.0.0",
    profile_id: "cn-default",
    config_version: "runtime",
    actor: "system/refresh",
    attempt: 1,
  },
  status: sequence === 2 ? "succeeded" : "running",
  progress: {
    total: 2,
    processed: sequence,
    created: sequence,
    failed: 0,
    skipped: 0,
  },
  expires_at: new Date("2026-09-21T00:00:00.000Z"),
}));

function authenticatedRequest(query = "run_id=refresh-1"): NextRequest {
  const secret = "plugin-job-events-route-test";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(`http://localhost/api/plugins/jobs/events?${query}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

test("plugin job events endpoint authenticates before reading", async () => {
  let reads = 0;
  const route = createPluginJobEventsRouteHandlers({
    getJob: async () => {
      reads += 1;
      return job;
    },
    listEvents: async () => {
      reads += 1;
      return events;
    },
  });
  const response = await route.GET(
    new NextRequest("http://localhost/api/plugins/jobs/events?run_id=refresh-1")
  );
  assert.equal(response.status, 401);
  assert.equal(reads, 0);
});

test("plugin job events endpoint returns a bounded forward page", async () => {
  let received:
    | { runId: string; afterSequence?: number; limit: number }
    | undefined;
  const route = createPluginJobEventsRouteHandlers({
    getJob: async (runId) => (runId === job.run_id ? job : null),
    listEvents: async (options) => {
      received = options;
      return events.filter((item) => item.sequence > (options.afterSequence ?? -1));
    },
  });
  const response = await route.GET(
    authenticatedRequest("run_id=refresh-1&after_sequence=0&limit=1")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(received, { runId: "refresh-1", afterSequence: 0, limit: 2 });
  assert.deepEqual(body.data.events.map((item: PluginJobEventRecord) => item.sequence), [1]);
  assert.equal(body.data.page.has_more, true);
  assert.equal(body.data.page.next_after_sequence, 1);
  assert.equal(body.data.writable, false);
});

test("plugin job events endpoint validates queries and missing runs", async () => {
  let eventReads = 0;
  const route = createPluginJobEventsRouteHandlers({
    getJob: async (runId) => (runId === job.run_id ? job : null),
    listEvents: async () => {
      eventReads += 1;
      return events;
    },
  });

  for (const query of [
    "",
    "run_id=%00bad",
    "run_id=refresh-1&limit=0",
    "run_id=refresh-1&limit=101",
    "run_id=refresh-1&after_sequence=-1",
  ]) {
    const response = await route.GET(authenticatedRequest(query));
    assert.equal(response.status, 400, query);
  }
  const missing = await route.GET(authenticatedRequest("run_id=missing"));
  assert.equal(missing.status, 404);
  assert.equal(eventReads, 0);
});

test("plugin job events endpoint redacts infrastructure failures", async () => {
  const route = createPluginJobEventsRouteHandlers({
    getJob: async () => job,
    listEvents: async () => {
      throw new RangeError(
        "mongodb://user:secret@example.invalid/plugin_job_events"
      );
    },
  });
  const response = await route.GET(authenticatedRequest());
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.message, "获取插件任务事件失败");
  assert.doesNotMatch(JSON.stringify(body), /user:secret/);
});
