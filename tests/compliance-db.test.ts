import assert from "node:assert/strict";
import test from "node:test";

import {
  ComplianceIdempotencyConflictError,
  createComplianceRepository,
  createInMemoryComplianceStore,
  pluginPolicyApprovalIssues,
} from "@/lib/compliance-db";
import {
  ensureComplianceIndexes,
  redactSensitive,
  REDACTED_VALUE,
} from "@/lib/compliance-types";

test("redacts credentials, sensitive URL parameters, hashes, and bounded snapshots", () => {
  const value = redactSensitive({
    token: "top-secret",
    share_code: "AB12",
    url: "https://example.test/share?id=1&token=abc#private",
    authorization: "Bearer abc.def.ghi",
    nested: { safe: "ok" },
  }) as Record<string, unknown>;

  assert.equal(value.token, REDACTED_VALUE);
  assert.equal(value.share_code, REDACTED_VALUE);
  assert.equal(value.authorization, REDACTED_VALUE);
  assert.equal(value.url, "https://example.test/share?id=1&token=%5BREDACTED%5D");
  assert.deepEqual(value.nested, { safe: "ok" });
});

test("approved policy requires operator evidence before it can authorize", async () => {
  const repository = createComplianceRepository(createInMemoryComplianceStore());
  const pending = await repository.upsertPluginPolicy({
    pluginId: "kerkerker.douban-content",
    pluginVersion: "1.0.0",
    status: "approved",
    enabled: true,
  });
  assert.ok(pluginPolicyApprovalIssues(pending).length > 0);

  const decision = await repository.ensurePluginAllowed({
    pluginId: "kerkerker.douban-content",
    pluginVersion: "1.0.0",
    mode: "enforce",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "policy-incomplete");

  const complete = await repository.upsertPluginPolicy({
    pluginId: "kerkerker.douban-content",
    pluginVersion: "1.0.0",
    status: "approved",
    enabled: true,
    owner: "compliance-team",
    authorizationRef: "license-2026-001",
    termsUrl: "https://example.test/terms",
    legalBasis: "licensed-metadata",
    contentScope: "movie-metadata",
    dataPurpose: "catalog display",
    regions: ["CN"],
    dataClassification: "licensed",
    retentionDays: 365,
    correctionContact: { email: "compliance@example.test" },
    takedownContact: { email: "takedown@example.test" },
    approvedBy: { type: "admin", id: "operator-1" },
    approvedAt: "2026-08-21T00:00:00.000Z",
  });
  assert.deepEqual(pluginPolicyApprovalIssues(complete), []);
  const allowed = await repository.ensurePluginAllowed({
    pluginId: "kerkerker.douban-content",
    pluginVersion: "1.0.0",
    region: "CN",
    mode: "enforce",
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "approved");
});

test("audit events are idempotent and conflicting replay is rejected", async () => {
  const repository = createComplianceRepository(createInMemoryComplianceStore());
  const first = await repository.recordAudit({
    idempotencyKey: "request-1",
    actor: { type: "admin", id: "operator-1" },
    action: "plugin.policy.approve",
    pluginId: "kerkerker.douban-content",
    before: { token: "secret" },
    after: { enabled: true },
  });
  const replay = await repository.recordAudit({
    idempotencyKey: "request-1",
    actor: { type: "admin", id: "operator-1" },
    action: "plugin.policy.approve",
    pluginId: "kerkerker.douban-content",
    before: { token: "another-secret" },
    after: { enabled: true },
  });
  assert.equal(replay.event_id, first.event_id);
  assert.equal((replay.before as Record<string, unknown>).token, REDACTED_VALUE);

  await assert.rejects(
    () => repository.recordAudit({
      idempotencyKey: "request-1",
      actor: { type: "admin", id: "operator-2" },
      action: "plugin.policy.disable",
    }),
    (error: unknown) => error instanceof ComplianceIdempotencyConflictError
  );
});

test("takedown blocks in enforce mode, can be resolved, and replays are stable", async () => {
  const repository = createComplianceRepository(createInMemoryComplianceStore());
  const record = await repository.createTakedown({
    idempotencyKey: "takedown-1",
    target: { type: "content", contentId: "550e8400-e29b-41d4-a716-446655440000" },
    reasonCode: "rights-holder-request",
    reason: "operator verified request",
    evidence: { url: "https://example.test/case?id=1&token=secret" },
  });
  const replay = await repository.createTakedown({
    idempotencyKey: "takedown-1",
    target: { type: "content", contentId: "550e8400-e29b-41d4-a716-446655440000" },
    reasonCode: "rights-holder-request",
    reason: "operator verified request",
    evidence: { url: "https://example.test/case?id=1&token=secret" },
  });
  assert.equal(replay.takedown_id, record.takedown_id);
  assert.equal((record.evidence as { url: string }).url, "https://example.test/case?id=1&token=%5BREDACTED%5D");
  assert.equal(record.expires_at, undefined);

  const blocked = await repository.ensurePluginAllowed({
    pluginId: "kerkerker.douban-content",
    contentId: "550e8400-e29b-41d4-a716-446655440000",
    mode: "enforce",
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "takedown-active");

  const auditBlocked = await repository.ensurePluginAllowed({
    pluginId: "kerkerker.douban-content",
    contentId: "550e8400-e29b-41d4-a716-446655440000",
    mode: "audit",
  });
  assert.equal(auditBlocked.allowed, false);
  assert.equal(auditBlocked.reason, "takedown-active");

  const resolved = await repository.resolveTakedown(record.takedown_id, {
    status: "resolved",
    resolvedBy: { type: "admin", id: "operator-1" },
  });
  assert.equal(resolved?.status, "resolved");
  const after = await repository.getActiveTakedown({
    contentId: "550e8400-e29b-41d4-a716-446655440000",
  });
  assert.equal(after, null);

  await assert.rejects(
    () => repository.resolveTakedown(record.takedown_id, { status: "active" } as never),
    /resolved、rejected 或 expired/
  );
});

test("takedown expiry is normalized to a BSON Date and filtered by date", async () => {
  const repository = createComplianceRepository(createInMemoryComplianceStore());
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const record = await repository.createTakedown({
    idempotencyKey: "takedown-with-expiry",
    target: { type: "resource", resourceId: "resource-1" },
    reasonCode: "temporary-review",
    reason: "temporary hold",
    expiresAt,
  });
  assert.ok(record.expires_at instanceof Date);
  assert.equal(record.expires_at?.toISOString(), expiresAt);
  assert.equal((await repository.listTakedowns({ resourceId: "resource-1" })).length, 1);
});

test("audit mode preserves registered legacy plugins but never unknown plugins", async () => {
  const repository = createComplianceRepository(createInMemoryComplianceStore());
  const legacy = await repository.ensurePluginAllowed({
    pluginId: "kerkerker.douban-content",
    mode: "audit",
  });
  assert.equal(legacy.allowed, true);
  assert.equal(legacy.wouldDeny, true);
  assert.equal(legacy.reason, "registered-legacy");

  const unknown = await repository.ensurePluginAllowed({
    pluginId: "example.unregistered",
    mode: "audit",
  });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, "plugin-not-registered");
});

test("compliance index setup declares unique identity and retention indexes", async () => {
  const calls: Array<{ collection: string; keys: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const fakeDb = {
    collection(name: string) {
      return {
        async createIndex(keys: Record<string, unknown>, options?: Record<string, unknown>) {
          calls.push({ collection: name, keys, options });
        },
      };
    },
  };
  await ensureComplianceIndexes(fakeDb as never);
  assert.ok(calls.some((call) => call.collection === "plugin_policies" && call.options?.unique === true));
  assert.ok(calls.some((call) => call.collection === "audit_events" && call.options?.expireAfterSeconds === 0));
  assert.ok(calls.some((call) => call.collection === "takedown_records" && "target.content_id" in call.keys));
  assert.ok(calls.some((call) => call.collection === "takedown_records" && call.options?.expireAfterSeconds === 0));
});
