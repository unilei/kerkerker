import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  listResourceCenterResources,
  parseResourceCenterQuery,
  ResourceCenterQueryError,
  toResourceCenterItem,
} from "@/lib/plugins/resource-center";
import {
  GET as getResources,
  createResourceCenterRouteHandlers,
} from "@/app/api/resources/route";
import type { PanResource } from "@/types/pan-resource";

const contentId = "550e8400-e29b-41d4-a716-446655440000";

function resource(overrides: Partial<PanResource> = {}): PanResource {
  return {
    id: overrides.id || "507f1f77bcf86cd799439011",
    douban_id: "1292052",
    content_id: contentId,
    brand: "quark",
    title: "测试资源",
    url: "https://pan.example/share",
    provider_id: "kerkerker.example-cloud-drive",
    provider_resource_id: "resource-1",
    enabled: true,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function adminRequest(url: string): NextRequest {
  process.env.ADMIN_SESSION_SECRET = "resource-center-test-secret";
  const token = createSessionToken({ secret: process.env.ADMIN_SESSION_SECRET });
  return new NextRequest(url, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

test("resource center query parser validates provider identity pairs", () => {
  const query = parseResourceCenterQuery(
    new URLSearchParams({
      content_id: contentId,
      provider_id: "kerkerker.example-cloud-drive",
      provider_resource_id: "resource-1",
      platform_id: "quark",
      enabled: "true",
      limit: "12",
    })
  );
  assert.deepEqual(query, {
    contentId,
    providerId: "kerkerker.example-cloud-drive",
    providerResourceId: "resource-1",
    platformId: "quark",
    enabled: true,
    limit: 12,
  });
  assert.throws(
    () => parseResourceCenterQuery(new URLSearchParams({ provider_id: "only-provider" })),
    (error: unknown) =>
      error instanceof ResourceCenterQueryError && /必须同时提供/.test(error.message)
  );
});

test("resource center projection omits legacy supplier fields", () => {
  const item = toResourceCenterItem(
    resource({ code: "AB12", kkpan_id: 42, source: "kkpan" })
  );
  assert.equal(item.provider?.id, "kerkerker.example-cloud-drive");
  assert.equal(item.provider?.resource_id, "resource-1");
  assert.equal(item.access_code, "AB12");
  assert.equal(item.identity_complete, true);
  assert.equal("douban_id" in item, false);
  assert.equal("kkpan_id" in item, false);
  assert.equal("source" in item, false);
});

test("resource center filters legacy rows and provider/platform without provider branches", async () => {
  const rows = [
    resource({ id: "507f1f77bcf86cd799439012", provider_resource_id: "resource-2", brand: "baidu" }),
    resource({ id: "507f1f77bcf86cd799439013", provider_id: undefined, provider_resource_id: undefined }),
    resource({ id: "507f1f77bcf86cd799439014", enabled: false }),
  ];
  const result = await listResourceCenterResources(
    {
      contentId,
      providerId: "kerkerker.example-cloud-drive",
      providerResourceId: "resource-2",
      platformId: "baidu",
      limit: 10,
    },
    { list: async () => rows }
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].platform.id, "baidu");

  const noLegacy = await listResourceCenterResources(
    { contentId, limit: 10 },
    { list: async () => rows }
  );
  assert.equal(noLegacy.length, 2);
  assert.equal(noLegacy.some((item) => !item.identity_complete), false);

  const withLegacy = await listResourceCenterResources(
    { contentId, includeLegacy: true, enabled: false, limit: 10 },
    { list: async () => rows }
  );
  assert.equal(withLegacy.length, 1);
  assert.equal(withLegacy[0].enabled, false);
});

test("public resource center service delegates policy filtering before projection", async () => {
  let policyCalled = false;
  const result = await listResourceCenterResources(
    { contentId, publicOnly: true, limit: 10 },
    {
      list: async () => [resource(), resource({ id: "507f1f77bcf86cd799439012" })],
      filterPublic: async (rows) => {
        policyCalled = true;
        return rows.slice(0, 1);
      },
    }
  );
  assert.equal(policyCalled, true);
  assert.equal(result.length, 1);
});

test("public resource center reads require content_id and force enabled identities", async () => {
  let seenQuery: unknown;
  const handlers = createResourceCenterRouteHandlers({
    list: async (query) => {
      seenQuery = query;
      return [toResourceCenterItem(resource())];
    },
  });
  const anonymousBroad = await getResources(
    new NextRequest("http://localhost/api/resources")
  );
  assert.equal(anonymousBroad.status, 401);

  const response = await handlers.GET(
    new NextRequest(
      `http://localhost/api/resources?content_id=${contentId}`
    )
  );
  assert.equal(response.status, 200);
  assert.equal((seenQuery as { enabled?: boolean }).enabled, true);
  assert.equal((seenQuery as { publicOnly?: boolean }).publicOnly, true);
  const body = await response.json();
  assert.equal(body.data.source, "resource-center");
  assert.equal(body.data.writable, false);
  assert.equal("douban_id" in body.data.resources[0], false);
});

test("resource center admin listing accepts disabled and legacy filters", async () => {
  const handlers = createResourceCenterRouteHandlers({
    list: async (query) => {
      assert.equal(query.enabled, false);
      assert.equal(query.includeLegacy, true);
      return [];
    },
  });
  const response = await handlers.GET(
    adminRequest(
      "http://localhost/api/resources?all=true&enabled=false&include_legacy=true"
    )
  );
  assert.equal(response.status, 200);
});

test("resource center returns 400 for malformed filters", async () => {
  const response = await getResources(
    adminRequest(
      "http://localhost/api/resources?all=true&provider_id=Bad%20Provider"
    )
  );
  assert.equal(response.status, 400);
});
