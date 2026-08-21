import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET as getContentCatalog } from "@/app/api/content/catalog/route";

test("content catalog route maps profile candidates to the legacy subject page", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/api\/v1\/category\?/);
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify({
        subjects: [
          {
            id: "1292052",
            title: "肖申克的救赎",
            rate: "9.7",
            cover: "https://image.example/poster.jpg",
            url: "https://movie.example/1292052",
            episode_info: "",
          },
        ],
        pagination: { page: 2, limit: 20, total: 41, hasMore: true },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const response = await getContentCatalog(
      new NextRequest("http://localhost/api/content/catalog?category=hot_movies&page=2&limit=20")
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.subjects[0].id, "1292052");
    assert.equal(body.data.pagination.page, 2);
    assert.equal(body.data.pagination.total, 41);
    assert.equal(body.data.pagination.hasMore, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("content catalog route rejects unsafe category and page values", async () => {
  const response = await getContentCatalog(
    new NextRequest("http://localhost/api/content/catalog?category=../secret&page=0")
  );
  assert.equal(response.status, 400);
});

test("content catalog route keeps top250 as a catalog capability", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/api\/v1\/250$/);
    return new Response(
      JSON.stringify({ subjects: [{ id: "1", title: "榜单片", rate: "8", cover: "", url: "" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const response = await getContentCatalog(
      new NextRequest("http://localhost/api/content/catalog?category=top250")
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.subjects[0].title, "榜单片");
    assert.equal(body.data.pagination.hasMore, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("content catalog does not allow a request to override the profile region", async () => {
  const response = await getContentCatalog(
    new NextRequest("http://localhost/api/content/catalog?view=latest&region=US")
  );
  assert.equal(response.status, 400);
});
