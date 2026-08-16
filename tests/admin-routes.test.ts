import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST as testDatabaseConnection } from "@/app/api/database/test/route";
import { GET as getAuthMe } from "@/app/api/auth/me/route";
import { GET as getKkpanSearch } from "@/app/api/kkpan/search/route";
import {
  POST as createPanResource,
  PUT as updatePanResource,
  DELETE as deletePanResource,
  GET as getPanResources,
} from "@/app/api/pan-resources/route";
import {
  GET as getSyncState,
  POST as runSync,
} from "@/app/api/pan-resources/sync-kkpan/route";

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("pan resource creation requires an authenticated admin session", async () => {
  const response = await createPanResource(
    jsonRequest("http://localhost/api/pan-resources", {
      douban_id: "123",
      brand: "quark",
      title: "测试资源",
      url: "https://pan.quark.cn/s/xxxxxx",
    })
  );

  assert.equal(response.status, 401);
});

test("pan resource updates require an authenticated admin session", async () => {
  const response = await updatePanResource(
    jsonRequest("http://localhost/api/pan-resources", {
      id: "507f1f77bcf86cd799439011",
      enabled: false,
    })
  );

  assert.equal(response.status, 401);
});

test("pan resource deletion requires an authenticated admin session", async () => {
  const response = await deletePanResource(
    new NextRequest(
      "http://localhost/api/pan-resources?id=507f1f77bcf86cd799439011",
      { method: "DELETE" }
    )
  );

  assert.equal(response.status, 401);
});

test("pan resource admin listing requires an authenticated admin session", async () => {
  const response = await getPanResources(
    new NextRequest("http://localhost/api/pan-resources?all=true")
  );

  assert.equal(response.status, 401);
});

test("session probe reports unauthenticated for anonymous visitors", async () => {
  const response = await getAuthMe(
    new NextRequest("http://localhost/api/auth/me")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.authenticated, false);
});

test("kkpans pull requires an authenticated admin session", async () => {
  const response = await getKkpanSearch(
    new NextRequest("http://localhost/api/kkpan/search?keyword=test")
  );

  assert.equal(response.status, 401);
});

test("kkpans sync requires an authenticated admin session (GET)", async () => {
  const response = await getSyncState(
    new NextRequest("http://localhost/api/pan-resources/sync-kkpan")
  );

  assert.equal(response.status, 401);
});

test("kkpans sync requires an authenticated admin session (POST)", async () => {
  const response = await runSync(
    jsonRequest("http://localhost/api/pan-resources/sync-kkpan", {
      mode: "incremental",
    })
  );

  assert.equal(response.status, 401);
});

test("database diagnostics require an authenticated admin session", async () => {
  const response = await testDatabaseConnection(
    jsonRequest("http://localhost/api/database/test", {})
  );

  assert.equal(response.status, 401);
});
