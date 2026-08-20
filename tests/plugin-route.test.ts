import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { GET as searchKkpan } from "@/app/api/kkpan/search/route";

function authenticatedRequest(keyword: string): NextRequest {
  const secret = "plugin-route-test-secret";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(
    `http://localhost/api/kkpan/search?keyword=${encodeURIComponent(keyword)}`,
    { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }
  );
}

test("legacy KKPAN search route invokes the profile-selected adapter", async () => {
  const previousFetch = globalThis.fetch;
  const expectedBase = process.env.KKPAN_API_BASE || "https://www.kkpans.com";
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).startsWith(`${expectedBase}/api/resources/public?`));
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify({
        total: 1,
        data: [
          {
            id: 12345,
            file_name: "✅━━测试影片 [2024][1080P].MKV",
            description: null,
            file_size: 23085449216,
            share_link: "https://pan.quark.cn/s/example",
            share_code: "ab12",
            target_platform: "quark",
            updated_at: "2026-08-20T01:02:03.000Z",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const response = await searchKkpan(authenticatedRequest("测试影片"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.items.length, 1);
    assert.deepEqual(body.data.items[0], {
      brand: "quark",
      title: "测试影片 [2024][1080P].MKV",
      url: "https://pan.quark.cn/s/example",
      code: "AB12",
      size: "21.5GB",
      format: "MKV",
      kkpan_id: 12345,
      source: "kkpan",
      provider_id: "kerkerker.kkpan-cloud-drive",
      provider_resource_id: "12345",
      updatedAt: "2026-08-20",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("legacy KKPAN search route keeps auth and upstream error boundaries", async () => {
  const anonymous = await searchKkpan(
    new NextRequest("http://localhost/api/kkpan/search?keyword=test")
  );
  assert.equal(anonymous.status, 401);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad gateway", { status: 503 });
  try {
    const response = await searchKkpan(authenticatedRequest("test"));
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.data, null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
