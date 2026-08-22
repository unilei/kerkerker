import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  createPluginJobLifecycleRouteHandlers,
} from "@/app/api/plugins/jobs/[run_id]/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  InMemoryPluginJobStore,
  PluginJobRunner,
  type PluginJobRun,
  type PluginJobRunnerPort,
} from "@/lib/plugins/job-runner";
import type { AuditEventInput } from "@/lib/compliance-types";

function authenticatedRequest(
  url: string,
  body: unknown,
  requestId = "lifecycle-route-test"
): NextRequest {
  const secret = "plugin-job-lifecycle-route-test";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "x-request-id": requestId,
    },
    body: JSON.stringify(body),
  });
}

function context(runId: string) {
  return { params: Promise.resolve({ run_id: runId }) };
}

function enqueueInput(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "content.catalog.sync",
    pluginId: "kerkerker.example",
    pluginVersion: "1.0.0",
    profileId: "cn-default",
    profile: "cn-default",
    configVersion: "config-1",
    actor: { type: "admin" as const, id: "admin-session" },
    idempotencyKey: "lifecycle:default",
    retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    metadata: { source: "test" },
    ...overrides,
  };
}

function dependencies(runner: PluginJobRunnerPort) {
  const audits: AuditEventInput[] = [];
  return {
    audits,
    handlers: createPluginJobLifecycleRouteHandlers({
      getRunner: async () => runner,
      writeAudit: async (input) => {
        audits.push(input);
      },
    }),
  };
}

async function failedRun(
  runner: PluginJobRunner,
  status: "failed" | "partial" = "failed",
  idempotencyKey = "lifecycle:failed"
): Promise<PluginJobRun> {
  const queued = await runner.enqueue(enqueueInput({ idempotencyKey }));
  const running = await runner.start({ runId: queued.run_id, owner: "test-worker" });
  return runner.finish(queued.run_id, {
    owner: running.lease!.owner,
    token: running.lease!.token,
    fence: running.lease!.fence,
  }, {
    status,
    error: { code: "UPSTREAM_ERROR", message: "temporary", retryable: true },
  });
}

test("generic job lifecycle endpoint authenticates before loading the runner", async () => {
  let loads = 0;
  const handlers = createPluginJobLifecycleRouteHandlers({
    getRunner: async () => {
      loads += 1;
      throw new Error("must not load");
    },
    writeAudit: async () => undefined,
  });
  const response = await handlers.POST(
    new NextRequest("http://localhost/api/plugins/jobs/run-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    }),
    context("run-1")
  );
  assert.equal(response.status, 401);
  assert.equal(loads, 0);
});

test("generic job lifecycle endpoint cancels a queued host run and writes an audit event", async () => {
  const runner = new PluginJobRunner(new InMemoryPluginJobStore());
  const queued = await runner.enqueue(enqueueInput({ idempotencyKey: "lifecycle:cancel" }));
  const { handlers, audits } = dependencies(runner);
  const response = await handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/jobs/run-1", {
      action: "cancel",
      reason: "上游已下架",
    }),
    context(queued.run_id)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.writable, true);
  assert.equal(body.data.operation, "cancel");
  assert.equal(body.data.job.status, "cancelled");
  assert.equal(body.data.job.cancel_requested, true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "plugin.job.cancel");
  assert.equal(audits[0].runId, queued.run_id);
  assert.equal(audits[0].reason, "上游已下架");
  assert.deepEqual(audits[0].before, {
    status: "queued",
    attempt: 0,
    cancel_requested: false,
    progress: { total: 0, processed: 0, created: 0, failed: 0, skipped: 0 },
    revision: 0,
  });
  assert.equal("metadata" in body.data.job, false);
  assert.equal("idempotency_key" in body.data.job, false);
});

test("lifecycle audit reasons redact embedded credentials", async () => {
  const runner = new PluginJobRunner(new InMemoryPluginJobStore());
  const queued = await runner.enqueue(enqueueInput({ idempotencyKey: "lifecycle:reason-redaction" }));
  const { handlers, audits } = dependencies(runner);
  const response = await handlers.POST(
    authenticatedRequest(
      "http://localhost/api/plugins/jobs/reason-redaction",
      { action: "cancel", reason: "failed https://user:secret@example.invalid/?token=abc" },
      "reason-redaction"
    ),
    context(queued.run_id)
  );
  assert.equal(response.status, 200);
  assert.ok(audits[0]?.reason);
  assert.doesNotMatch(String(audits[0]?.reason), /user:secret|token=abc/);
});

test("generic job lifecycle endpoint retries failed and partial host runs", async () => {
  const runner = new PluginJobRunner(new InMemoryPluginJobStore());
  const failed = await failedRun(runner);
  const { handlers, audits } = dependencies(runner);
  const response = await handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/jobs/failed", {
      action: "retry",
    }),
    context(failed.run_id)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.operation, "retry");
  assert.equal(body.data.job.status, "queued");
  assert.equal(body.data.job.attempt, 1);
  assert.equal(audits[0].action, "plugin.job.retry");

  const partial = await failedRun(runner, "partial", "lifecycle:partial");
  const partialDeps = dependencies(runner);
  const partialResponse = await partialDeps.handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/jobs/partial", { action: "retry" }, "partial-request"),
    context(partial.run_id)
  );
  assert.equal(partialResponse.status, 200);
  assert.equal((await partialResponse.json()).data.job.status, "queued");
});

test("lifecycle endpoint rejects shadow, external-report, Pan migration, and invalid states", async () => {
  const base = {
    run_id: "run",
    job_id: "content.catalog.sync",
    control_mode: "host" as const,
    plugin_id: "kerkerker.example",
    plugin_version: "1.0.0",
    profile_id: "cn-default",
    profile: "cn-default",
    config_version: "config-1",
    actor: { type: "system" as const },
    idempotency_key: "run",
    status: "queued" as const,
    attempt: 0,
    retry_policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    lease_fence: 0,
    cancel_requested: false,
    progress: { total: 0, processed: 0, created: 0, failed: 0, skipped: 0 },
    metadata: { source: "test" },
    revision: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } satisfies PluginJobRun;

  const cases: Array<{ label: string; run: PluginJobRun; action: "cancel" | "retry" }> = [
    { label: "shadow", run: { ...base, host_claimable: false }, action: "cancel" },
    { label: "invalid job id", run: { ...base, job_id: "Bad Job" }, action: "cancel" },
    { label: "external", run: { ...base, control_mode: "external-report" }, action: "cancel" },
    { label: "pan", run: { ...base, metadata: { source: "pan-scheduler" }, host_claimable: true }, action: "cancel" },
    { label: "succeeded cancel", run: { ...base, status: "succeeded" }, action: "cancel" },
    { label: "queued retry", run: { ...base }, action: "retry" },
    { label: "cancelled retry", run: { ...base, status: "failed", cancel_requested: true }, action: "retry" },
  ];

  for (const item of cases) {
    const store = new InMemoryPluginJobStore();
    await store.create(item.run);
    const runner = new PluginJobRunner(store);
    const { handlers, audits } = dependencies(runner);
    const response = await handlers.POST(
      authenticatedRequest(`http://localhost/api/plugins/jobs/${item.label}`, { action: item.action }, item.label),
      context(item.run.run_id)
    );
    assert.equal(response.status, 409, item.label);
    assert.equal(audits.length, 0, item.label);
  }
});

test("lifecycle endpoint validates body and path before reading the runner", async () => {
  let loads = 0;
  const handlers = createPluginJobLifecycleRouteHandlers({
    getRunner: async () => {
      loads += 1;
      throw new Error("must not load");
    },
    writeAudit: async () => undefined,
  });
  const requests = [
    ["bad/run", { action: "cancel" }],
    ["run-1", { action: "delete" }],
    ["run-1", { action: "cancel", extra: true }],
    ["run-1", { action: "cancel", reason: "\n" }],
  ] as const;
  for (const [runId, body] of requests) {
    const response = await handlers.POST(
      authenticatedRequest("http://localhost/api/plugins/jobs/" + runId, body, runId),
      context(runId)
    );
    assert.equal(response.status, 400, runId);
  }
  const missingContentType = await handlers.POST(
    (() => {
      const request = authenticatedRequest("http://localhost/api/plugins/jobs/run-1", { action: "cancel" });
      request.headers.delete("content-type");
      return request;
    })(),
    context("run-1")
  );
  assert.equal(missingContentType.status, 400);
  assert.equal(loads, 0);
});

test("lifecycle endpoint does not expose sensitive job fields", async () => {
  const runner = new PluginJobRunner(new InMemoryPluginJobStore());
  const queued = await runner.enqueue(enqueueInput({
    idempotencyKey: "lifecycle:redaction",
    metadata: { api_key: "must-not-leak", cursor: "secret" },
  }));
  const { handlers } = dependencies(runner);
  const response = await handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/jobs/redaction", { action: "cancel" }),
    context(queued.run_id)
  );
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.equal(response.status, 200);
  assert.doesNotMatch(serialized, /must-not-leak|secret|metadata|idempotency_key|lease/);
});
