import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

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
import {
  GET as getCatalogSync,
  POST as runCatalogSync,
} from "@/app/api/pan-resources/catalog-sync/route";

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function authenticatedRawRequest(
  url: string,
  method: "POST" | "PUT",
  body: string
): NextRequest {
  const secret = "admin-route-test-secret";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    },
    body,
  });
}

function authenticatedGetRequest(url: string): NextRequest {
  const secret = "admin-route-test-secret";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(url, {
    method: "GET",
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
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

test("authenticated pan resource writes reject malformed JSON with 400", async () => {
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  try {
    const createResponse = await createPanResource(
      authenticatedRawRequest(
        "http://localhost/api/pan-resources",
        "POST",
        "{"
      )
    );
    assert.equal(createResponse.status, 400);

    const updateResponse = await updatePanResource(
      authenticatedRawRequest(
        "http://localhost/api/pan-resources",
        "PUT",
        "null"
      )
    );
    assert.equal(updateResponse.status, 400);
  } finally {
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = previousSecret;
  }
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

test("kkpans sync accepts the configured cron Bearer secret", async () => {
  const previous = process.env.KKPAN_SYNC_CRON_SECRET;
  process.env.KKPAN_SYNC_CRON_SECRET = "test-cron-secret";
  try {
    const response = await runSync(
      new NextRequest("http://localhost/api/pan-resources/sync-kkpan", {
        method: "POST",
        headers: { authorization: "Bearer test-cron-secret" },
        body: "{",
      })
    );

    // 通过鉴权后才会解析 body；非法 JSON 的 400 证明没有依赖登录 cookie。
    assert.equal(response.status, 400);
  } finally {
    if (previous === undefined) delete process.env.KKPAN_SYNC_CRON_SECRET;
    else process.env.KKPAN_SYNC_CRON_SECRET = previous;
  }
});

test("catalog sync requires an authenticated admin session", async () => {
  const getResponse = await getCatalogSync(
    new NextRequest("http://localhost/api/pan-resources/catalog-sync")
  );
  const postResponse = await runCatalogSync(
    jsonRequest("http://localhost/api/pan-resources/catalog-sync", {
      action: "discover",
    })
  );

  assert.equal(getResponse.status, 401);
  assert.equal(postResponse.status, 401);
});

test("authenticated catalog sync validates body and query before touching the database", async () => {
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  try {
    const malformed = await runCatalogSync(
      authenticatedRawRequest(
        "http://localhost/api/pan-resources/catalog-sync",
        "POST",
        "{"
      )
    );
    assert.equal(malformed.status, 400);

    const invalidId = await runCatalogSync(
      authenticatedRawRequest(
        "http://localhost/api/pan-resources/catalog-sync",
        "POST",
        JSON.stringify({ action: "sync", douban_id: "not-an-id", limit: 1 })
      )
    );
    assert.equal(invalidId.status, 400);

    const invalidQuery = await getCatalogSync(
      authenticatedGetRequest(
        "http://localhost/api/pan-resources/catalog-sync?status=unknown"
      )
    );
    assert.equal(invalidQuery.status, 400);
  } finally {
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = previousSecret;
  }
});

test("catalog sync accepts the configured cron Bearer secret", async () => {
  const previous = process.env.KKPAN_SYNC_CRON_SECRET;
  process.env.KKPAN_SYNC_CRON_SECRET = "catalog-cron-secret";
  try {
    const response = await runCatalogSync(
      new NextRequest("http://localhost/api/pan-resources/catalog-sync", {
        method: "POST",
        headers: { authorization: "Bearer catalog-cron-secret" },
        body: "{",
      })
    );

    assert.equal(response.status, 400);
  } finally {
    if (previous === undefined) delete process.env.KKPAN_SYNC_CRON_SECRET;
    else process.env.KKPAN_SYNC_CRON_SECRET = previous;
  }
});

test("database diagnostics require an authenticated admin session", async () => {
  const response = await testDatabaseConnection(
    jsonRequest("http://localhost/api/database/test", {})
  );

  assert.equal(response.status, 401);
});
