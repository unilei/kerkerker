import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET as getContentCatalog } from "@/app/api/content/catalog/route";
import { LOCALE_COOKIE_NAME } from "@/lib/locale";

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

test("content catalog route exposes an actionable status when the locale plugin is unavailable", async () => {
  const previousEnforce = process.env.KERKERKER_PLUGIN_INSTALLATION_ENFORCE;
  const previousTmdbKey = process.env.TMDB_API_KEY;
  process.env.KERKERKER_PLUGIN_INSTALLATION_ENFORCE = "true";
  process.env.TMDB_API_KEY = "test-tmdb-key";
  try {
    const response = await getContentCatalog(
      new NextRequest("http://localhost/api/content/catalog?view=featured", {
        headers: { cookie: `${LOCALE_COOKIE_NAME}=en-US` },
      })
    );
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error_code, "CAPABILITY_UNAVAILABLE");
    assert.equal(body.profile_id, "en-default");
    assert.equal(body.data, null);
  } finally {
    if (previousEnforce === undefined) delete process.env.KERKERKER_PLUGIN_INSTALLATION_ENFORCE;
    else process.env.KERKERKER_PLUGIN_INSTALLATION_ENFORCE = previousEnforce;
    if (previousTmdbKey === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = previousTmdbKey;
  }
});

test("catalog route exposes actionable status for an unavailable locale plugin", async () => {
  const previousKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = "";
  try {
    const response = await getContentCatalog(
      new NextRequest("http://localhost/api/content/catalog?view=featured", {
        headers: { cookie: "kk_locale=en-US" },
      })
    );
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 503);
    assert.equal(body.error_code, "CONFIGURATION_ERROR");
    assert.equal(body.profile_id, "en-default");
    assert.match(body.message, /配置不完整/);
  } finally {
    if (previousKey === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = previousKey;
  }
});
