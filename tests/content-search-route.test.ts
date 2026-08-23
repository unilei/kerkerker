import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET as searchContent } from "@/app/api/content/search/route";

test("content search route returns a profile-normalized host DTO", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/api\/v1\/search\?q=/);
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify({
        advanced: [
          {
            id: "1292052",
            title: "肖申克的救赎",
            rate: "9.7",
            cover: "https://image.example/poster.jpg",
            url: "https://movie.example/1292052",
            episode_info: "",
          },
        ],
        suggest: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const response = await searchContent(
      new NextRequest("http://localhost/api/content/search?q=肖申克")
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.profile, "cn-default");
    assert.deepEqual(body.data.items[0], {
      id: "1292052",
      provider_id: "kerkerker.douban-content",
      title: "肖申克的救赎",
      cover: "https://image.example/poster.jpg",
      rate: "9.7",
      episode_info: "",
      url: "https://movie.example/1292052",
      release_date: "",
      type: "movie",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("content search validates query and profile before upstream access", async () => {
  const empty = await searchContent(
    new NextRequest("http://localhost/api/content/search?q=")
  );
  assert.equal(empty.status, 400);

  const previousProfile = process.env.KERKERKER_PLUGIN_PROFILE;
  process.env.KERKERKER_PLUGIN_PROFILE = "missing";
  try {
    const unknown = await searchContent(
      new NextRequest("http://localhost/api/content/search?q=test")
    );
    assert.equal(unknown.status, 503);
    const body = await unknown.json();
    assert.equal(body.error_code, "CONFIGURATION_ERROR");
    assert.equal(body.profile_id, "unknown");
    assert.equal(body.data, null);
  } finally {
    if (previousProfile === undefined) delete process.env.KERKERKER_PLUGIN_PROFILE;
    else process.env.KERKERKER_PLUGIN_PROFILE = previousProfile;
  }
});

test("content search tolerates the Douban service null advanced field", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      advanced: null,
      suggest: [{
        id: "1292052",
        title: "肖申克的救赎",
        img: "https://image.example/poster.jpg",
        url: "https://movie.example/1292052",
        type: "movie",
        year: "1994",
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  try {
    const response = await searchContent(
      new NextRequest("http://localhost/api/content/search?q=肖申克")
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.items[0].title, "肖申克的救赎");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
