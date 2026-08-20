import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET as getContentCatalog } from "@/app/api/content/catalog/route";

test("featured catalog view maps the provider hero feed to the neutral host DTO", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/api\/v1\/hero$/);
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify([
        {
          id: "1292052",
          title: "肖申克的救赎",
          rate: "9.7",
          cover: "https://image.example/cover.jpg",
          poster_horizontal: "https://image.example/backdrop.jpg",
          poster_vertical: "https://image.example/poster.jpg",
          url: "https://movie.example/1292052",
          episode_info: "",
          genres: ["剧情", "犯罪"],
          description: "希望让人自由。",
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await getContentCatalog(
      new NextRequest("http://localhost/api/content/catalog?view=featured")
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.view, "featured");
    assert.equal(body.data.items[0].id, "1292052");
    assert.equal(body.data.items[0].posterUrl, "https://image.example/poster.jpg");
    assert.equal(body.data.items[0].backdropUrl, "https://image.example/backdrop.jpg");
    assert.deepEqual(body.data.items[0].genres, ["剧情", "犯罪"]);
    assert.equal(body.data.items[0].description, "希望让人自由。");
    assert.deepEqual(body.data.sections, []);
    assert.equal("providerId" in body.data.items[0], false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("new-releases catalog view preserves provider sections without exposing provider fields", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/api\/v1\/new$/);
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify([
        {
          name: "热门新片",
          data: [
            {
              id: "new-1",
              title: "新片一",
              rate: "8.1",
              cover: "https://image.example/new-1.jpg",
              url: "https://movie.example/new-1",
              episode_info: "",
            },
          ],
        },
        {
          name: "新剧集",
          data: [
            {
              id: "new-2",
              title: "新剧一",
              rate: "8.5",
              cover: "https://image.example/new-2.jpg",
              url: "https://movie.example/new-2",
              episode_info: "全 8 集",
            },
          ],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await getContentCatalog(
      new NextRequest("http://localhost/api/content/catalog?view=new-releases")
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.view, "new-releases");
    assert.deepEqual(
      body.data.sections.map((section: { key: string; title: string }) => [
        section.key,
        section.title,
      ]),
      [["热门新片", "热门新片"], ["新剧集", "新剧集"]]
    );
    assert.equal(body.data.sections[1].items[0].episodeInfo, "全 8 集");
    assert.equal(body.data.items.length, 2);
    assert.equal("providerId" in body.data.items[0], false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("catalog route rejects undeclared views before invoking a plugin", async () => {
  const response = await getContentCatalog(
    new NextRequest("http://localhost/api/content/catalog?view=provider-private-feed")
  );
  assert.equal(response.status, 400);
});
