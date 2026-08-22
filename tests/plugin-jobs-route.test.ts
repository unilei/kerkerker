import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { createPluginJobsRouteHandlers } from "@/app/api/plugins/jobs/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import type { PluginJobRun } from "@/lib/plugins/job-runner";

const jobs: PluginJobRun[] = [
  {
    run_id: "run-1",
    plugin_id: "kerkerker.example",
    plugin_version: "1.0.0",
    profile_id: "cn-default",
    profile: "cn-default",
    config_version: "config-1",
    actor: { type: "admin", id: "admin-session" },
    idempotency_key: "job:run-1",
    status: "running",
    attempt: 1,
    retry_policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    cancel_requested: false,
    cursor: "opaque?token=must-not-leak",
    progress: { total: 10, processed: 4, created: 2, failed: 0, skipped: 2 },
    metadata: { logical_window: "2026-08-21" },
    revision: 2,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:01:00.000Z",
  },
  {
    ...jobsPlaceholder(),
  },
];

function jobsPlaceholder(): PluginJobRun {
  return {
    run_id: "run-2",
    plugin_id: "kerkerker.example",
    plugin_version: "1.0.0",
    profile_id: "en-default",
    profile: "en-default",
    config_version: "config-2",
    actor: { type: "system", id: "refresh" },
    idempotency_key: "job:run-2",
    status: "failed",
    attempt: 3,
    retry_policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 },
    cancel_requested: false,
    progress: { total: 10, processed: 10, created: 8, failed: 2, skipped: 0 },
    error: {
      message: "GET https://user:pass@example.invalid/fail?token=must-not-leak failed",
      retryable: false,
    },
    metadata: { logical_window: "2026-08-20", api_key: "must-not-leak" },
    revision: 4,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:01:00.000Z",
  };
}

function authenticatedRequest(url: string): NextRequest {
  const secret = "plugin-jobs-route-test";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(url, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

test("plugin jobs endpoint requires admin auth before reading Mongo", async () => {
  let reads = 0;
  const handlers = createPluginJobsRouteHandlers({
    listJobs: async () => {
      reads += 1;
      return jobs;
    },
    getJob: async () => {
      reads += 1;
      return null;
    },
  });

  const response = await handlers.GET(
    new NextRequest("http://localhost/api/plugins/jobs")
  );

  assert.equal(response.status, 401);
  assert.equal(reads, 0);
});

test("plugin jobs endpoint forwards status and bounded limit and marks view read-only", async () => {
  let received: { status?: string; limit: number } | undefined;
  const handlers = createPluginJobsRouteHandlers({
    listJobs: async (options) => {
      received = options;
      return jobs;
    },
    getJob: async (runId) => jobs.find((job) => job.run_id === runId) || null,
  });

  const response = await handlers.GET(
    authenticatedRequest(
      "http://localhost/api/plugins/jobs?status=running&limit=1&run_id=run-1"
    )
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(received, undefined);
  assert.equal(body.data.source, "plugin_jobs");
  assert.equal(body.data.writable, false);
  assert.equal(body.data.filters.status, "running");
  assert.equal(body.data.filters.runId, "run-1");
  assert.deepEqual(body.data.jobs.map((job: PluginJobRun) => job.run_id), ["run-1"]);
  for (const internalField of [
    "idempotency_key",
    "cursor",
    "metadata",
    "pending_event_receipt",
  ]) {
    assert.equal(internalField in body.data.jobs[0], false, internalField);
  }
  assert.equal(body.data.jobs[0].timeline_pending, false);

  const listResponse = await handlers.GET(
    authenticatedRequest("http://localhost/api/plugins/jobs?status=running&limit=1")
  );
  assert.equal(listResponse.status, 200);
  assert.deepEqual(received, { status: "running", limit: 1 });
});

test("plugin jobs endpoint rejects invalid filters before reading Mongo", async () => {
  let reads = 0;
  const handlers = createPluginJobsRouteHandlers({
    listJobs: async () => {
      reads += 1;
      return jobs;
    },
    getJob: async () => {
      reads += 1;
      return null;
    },
  });

  for (const query of ["status=unknown", "limit=0", "limit=101", "run_id=%00bad"]) {
    const response = await handlers.GET(
      authenticatedRequest(`http://localhost/api/plugins/jobs?${query}`)
    );
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).data, null);
  }
  assert.equal(reads, 0);
});

test("plugin jobs endpoint redacts infrastructure errors", async () => {
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  const handlers = createPluginJobsRouteHandlers({
    listJobs: async () => {
      throw new RangeError("mongodb://user:secret@example.invalid/plugin_jobs");
    },
    getJob: async () => {
      throw new RangeError("mongodb://user:secret@example.invalid/plugin_jobs");
    },
  });

  try {
    const response = await handlers.GET(
      authenticatedRequest("http://localhost/api/plugins/jobs")
    );
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.message, "获取插件任务记录失败");
    assert.equal(body.data, null);
    assert.doesNotMatch(JSON.stringify(body), /user:secret/);
    assert.doesNotMatch(JSON.stringify(logged), /user:secret/);
    assert.match(JSON.stringify(logged), /Error/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("plugin jobs endpoint removes internal state and redacts stored errors", async () => {
  const handlers = createPluginJobsRouteHandlers({
    listJobs: async () => jobs,
    getJob: async (runId) => jobs.find((job) => job.run_id === runId) || null,
  });
  const response = await handlers.GET(
    authenticatedRequest("http://localhost/api/plugins/jobs?run_id=run-2")
  );
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.doesNotMatch(serialized, /must-not-leak|api_key|idempotency_key|metadata/);
  assert.match(body.data.jobs[0].error.message, /\[REDACTED\]/);
});

test("plugin jobs endpoint returns not found for an unknown run", async () => {
  const handlers = createPluginJobsRouteHandlers({
    listJobs: async () => jobs,
    getJob: async () => null,
  });
  const response = await handlers.GET(
    authenticatedRequest("http://localhost/api/plugins/jobs?run_id=missing")
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).data, null);
});
