import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  createAuditRouteHandlers,
} from "@/app/api/plugins/audit/route";
import {
  createPolicyRouteHandlers,
} from "@/app/api/plugins/policy/route";
import {
  createTakedownRouteHandlers,
} from "@/app/api/plugins/takedown/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  createComplianceRepository,
  createInMemoryComplianceStore,
} from "@/lib/compliance-db";
import {
  filterPublicPanResources,
  recordPanResourceMutation,
} from "@/lib/pan/resource-audit";
import { pluginRegistry } from "@/lib/plugins";
import type { PanResource } from "@/types/pan-resource";

function authenticatedRequest(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): NextRequest {
  const secret = "plugin-compliance-route-test";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(url, {
    method: init.method,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

function complianceHandlers() {
  const repository = createComplianceRepository(createInMemoryComplianceStore());
  const plugins = pluginRegistry.list();
  return {
    repository,
    descriptor: plugins[0],
    policy: createPolicyRouteHandlers({
      listPolicies: (query) => repository.listPluginPolicies(query),
      upsertPolicy: (input) => repository.upsertPluginPolicy(input),
      writeAudit: (input) => repository.recordAudit(input),
      listPlugins: () => plugins,
    }),
    audit: createAuditRouteHandlers({
      listEvents: (query) => repository.listAuditEvents(query),
    }),
    takedown: createTakedownRouteHandlers({
      listRecords: (query) => repository.listTakedowns(query),
      createRecord: (input) => repository.createTakedown(input),
      resolveRecord: (id, input) => repository.resolveTakedown(id, input),
      writeAudit: (input) => repository.recordAudit(input),
    }),
  };
}

test("plugin policy API requires admin auth and rejects unknown plugins", async () => {
  const { policy } = complianceHandlers();
  const anonymous = await policy.GET(
    new NextRequest("http://localhost/api/plugins/policy")
  );
  assert.equal(anonymous.status, 401);

  const unknown = await policy.POST(
    authenticatedRequest("http://localhost/api/plugins/policy", {
      method: "POST",
      body: {
        action: "approve",
        plugin_id: "example.unknown",
        reason: "测试审批",
      },
    })
  );
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).message, /未注册/);
});

test("plugin policy API approves, disables, enables, and audits a registered plugin", async () => {
  const { descriptor, policy, audit } = complianceHandlers();

  const approve = await policy.POST(
    authenticatedRequest("http://localhost/api/plugins/policy", {
      method: "POST",
      body: {
        action: "approve",
        plugin_id: descriptor.id,
        plugin_version: descriptor.version,
        reason: "授权材料已人工复核",
        enforcement_mode: "enforce",
        owner: "Kerkerker",
        authorization_ref: "approval-2026-001",
        license: "operator-approved",
        legal_basis: "licensed-metadata",
        terms_url: "https://example.invalid/terms",
        content_scope: "movie-metadata",
        data_purpose: "影视目录展示",
        retention_days: 365,
        correction_contact: "compliance@example.invalid",
        takedown_contact: "admin@example.invalid",
      },
      headers: { "x-request-id": "policy-approve-1" },
    })
  );
  assert.equal(approve.status, 200);
  const approvedBody = await approve.json();
  assert.equal(approvedBody.data.policy.status, "approved");
  assert.equal(approvedBody.data.policy.enabled, true);
  assert.equal(approvedBody.data.policy.enforcement_mode, "enforce");

  const disable = await policy.POST(
    authenticatedRequest("http://localhost/api/plugins/policy", {
      method: "POST",
      body: {
        action: "disable",
        plugin_id: descriptor.id,
        reason: "上游维护，临时停用",
      },
    })
  );
  assert.equal(disable.status, 200);
  assert.equal((await disable.json()).data.policy.enabled, false);

  const enable = await policy.POST(
    authenticatedRequest("http://localhost/api/plugins/policy", {
      method: "POST",
      body: {
        action: "enable",
        plugin_id: descriptor.id,
        reason: "维护结束，恢复调用",
      },
    })
  );
  assert.equal(enable.status, 200);
  assert.equal((await enable.json()).data.policy.enabled, true);

  const listing = await policy.GET(
    authenticatedRequest(
      `http://localhost/api/plugins/policy?plugin_id=${encodeURIComponent(descriptor.id)}`
    )
  );
  assert.equal(listing.status, 200);
  const listingBody = await listing.json();
  assert.equal(listingBody.data.plugins.length, 1);
  assert.equal(listingBody.data.plugins[0].policy.status, "approved");

  const auditResponse = await audit.GET(
    authenticatedRequest(
      `http://localhost/api/plugins/audit?plugin_id=${encodeURIComponent(descriptor.id)}&limit=10`
    )
  );
  assert.equal(auditResponse.status, 200);
  const events = (await auditResponse.json()).data.events;
  assert.deepEqual(
    events.map((event: { action: string }) => event.action).sort(),
    [
      "plugin.policy.approve",
      "plugin.policy.disable",
      "plugin.policy.enable",
    ]
  );
  assert.ok(events.every((event: { actor: { type: string } }) => event.actor.type === "admin"));
});

test("plugin policy API cannot enable an unapproved policy", async () => {
  const { descriptor, policy } = complianceHandlers();
  const response = await policy.POST(
    authenticatedRequest("http://localhost/api/plugins/policy", {
      method: "POST",
      body: {
        action: "enable",
        plugin_id: descriptor.id,
        reason: "尝试跳过审批",
      },
    })
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /尚未完成审批/);
});

test("plugin policy API refuses approval without compliance evidence", async () => {
  const { descriptor, policy } = complianceHandlers();
  const response = await policy.POST(
    authenticatedRequest("http://localhost/api/plugins/policy", {
      method: "POST",
      body: {
        action: "approve",
        plugin_id: descriptor.id,
        reason: "缺少授权材料",
      },
    })
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /审批材料不完整/);
});

test("audit API validates filters before querying the repository", async () => {
  const { audit } = complianceHandlers();
  const response = await audit.GET(
    authenticatedRequest("http://localhost/api/plugins/audit?limit=invalid")
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /limit/);
});

test("takedown API creates, lists, resolves, and audits records", async () => {
  const { descriptor, takedown, audit } = complianceHandlers();
  const contentId = "a65a5ad5-d7de-4df2-9940-c4c7753c20f3";
  const created = await takedown.POST(
    authenticatedRequest("http://localhost/api/plugins/takedown", {
      method: "POST",
      body: {
        action: "create",
        target: {
          type: "content",
          content_id: contentId,
          plugin_id: descriptor.id,
        },
        reason_code: "rights-request",
        reason: "权利人要求临时下架",
      },
    })
  );
  assert.equal(created.status, 200);
  const record = (await created.json()).data.record;
  assert.equal(record.status, "active");

  const resolved = await takedown.POST(
    authenticatedRequest("http://localhost/api/plugins/takedown", {
      method: "POST",
      body: {
        action: "resolve",
        takedown_id: record.takedown_id,
        resolution_reason: "权利材料复核完成",
      },
    })
  );
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).data.record.status, "resolved");

  const listed = await takedown.GET(
    authenticatedRequest(
      `http://localhost/api/plugins/takedown?content_id=${contentId}&include_expired=true`
    )
  );
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.records.length, 1);

  const audited = await audit.GET(
    authenticatedRequest("http://localhost/api/plugins/audit?action=takedown.resolve")
  );
  assert.equal(audited.status, 200);
  assert.equal((await audited.json()).data.events.length, 1);
});

test("pan resource mutation audit records host identity and redacts secrets", async () => {
  const repository = createComplianceRepository(createInMemoryComplianceStore());
  const resource: PanResource = {
    id: "resource-1",
    douban_id: "1292052",
    content_id: "a65a5ad5-d7de-4df2-9940-c4c7753c20f3",
    brand: "quark",
    title: "测试资源",
    url: "https://pan.example/resource?token=secret",
    code: "ABCD",
    provider_id: "kerkerker.kkpan-cloud-drive",
    provider_resource_id: "42",
    enabled: true,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
  };
  const request = authenticatedRequest("http://localhost/api/pan-resources", {
    headers: { "x-request-id": "resource-audit-1" },
  });
  await recordPanResourceMutation(
    request,
    "create",
    resource,
    {},
    (input) => repository.recordAudit(input)
  );
  const events = await repository.listAuditEvents({ limit: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "resource.pan.create");
  assert.equal(events[0].content_id, resource.content_id);
  assert.equal(events[0].provider_id, resource.provider_id);
  const after = events[0].after as { code: string; url: string };
  assert.equal(after.code, "[REDACTED]");
  assert.match(after.url, /token=%5BREDACTED%5D/);
});

test("public pan resources are filtered by content, provider, and resource takedowns", async () => {
  const contentId = "a65a5ad5-d7de-4df2-9940-c4c7753c20f3";
  const resources: PanResource[] = [
    {
      id: "resource-1",
      douban_id: "1",
      content_id: contentId,
      provider_id: "kerkerker.kkpan-cloud-drive",
      provider_resource_id: "1",
      brand: "quark",
      title: "one",
      url: "https://example.test/one",
      enabled: true,
      created_at: "2026-08-21T00:00:00.000Z",
      updated_at: "2026-08-21T00:00:00.000Z",
    },
    {
      id: "resource-2",
      douban_id: "2",
      brand: "baidu",
      title: "two",
      url: "https://example.test/two",
      enabled: true,
      created_at: "2026-08-21T00:00:00.000Z",
      updated_at: "2026-08-21T00:00:00.000Z",
    },
  ];
  const filtered = await filterPublicPanResources(
    resources,
    async (target) =>
      target.contentId === contentId ? { takedown_id: "content-block" } : null,
    {}
  );
  assert.deepEqual(filtered.map((resource) => resource.id), ["resource-2"]);
});

test("public pan resources are hidden when the provider policy denies access", async () => {
  const resources: PanResource[] = [
    {
      id: "resource-policy-blocked",
      douban_id: "3",
      provider_id: "kerkerker.kkpan-cloud-drive",
      provider_resource_id: "3",
      brand: "quark",
      title: "blocked",
      url: "https://example.test/blocked",
      enabled: true,
      created_at: "2026-08-21T00:00:00.000Z",
      updated_at: "2026-08-21T00:00:00.000Z",
    },
  ];
  const filtered = await filterPublicPanResources(
    resources,
    async () => null,
    {},
    async () => ({ allowed: false, wouldDeny: true, reason: "policy-disabled" })
  );
  assert.deepEqual(filtered, []);
});

test("public pan resources are hidden when the source plugin is not usable", async () => {
  const resources: PanResource[] = [
    {
      id: "resource-installation-blocked",
      douban_id: "4",
      provider_id: "kerkerker.kkpan-cloud-drive",
      provider_resource_id: "4",
      brand: "quark",
      title: "blocked until install",
      url: "https://example.test/blocked-installation",
      enabled: true,
      created_at: "2026-08-21T00:00:00.000Z",
      updated_at: "2026-08-21T00:00:00.000Z",
    },
  ];
  const filtered = await filterPublicPanResources(
    resources,
    async () => null,
    {},
    async () => ({ allowed: true }),
    async () => false
  );
  assert.deepEqual(filtered, []);
});
