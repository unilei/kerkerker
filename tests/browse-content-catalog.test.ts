import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET as getContentCatalog } from "@/app/api/content/catalog/route";

test("sections catalog view maps the series collection to neutral sections", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/api\/v1\/tv$/);
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify({
        code: 200,
        data: [
          {
            name: "热门剧集",
            data: [
              {
                id: "series-1",
                title: "剧集一",
                rate: "8.8",
                cover: "https://image.example/series-1.jpg",
                url: "https://movie.example/series-1",
                episode_info: "全 12 集",
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await getContentCatalog(
      new NextRequest("http://localhost/api/content/catalog?view=sections&key=series")
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.view, "sections");
    assert.equal(body.data.key, "series");
    assert.equal(body.data.sections[0].title, "热门剧集");
    assert.equal(body.data.sections[0].items[0].episodeInfo, "全 12 集");
    assert.equal(body.data.items[0].rating, "8.8");
    assert.equal("providerId" in body.data.items[0], false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("latest catalog view translates neutral filters and preserves provider pagination", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/new");
    assert.equal(url.searchParams.get("genre"), "科幻");
    assert.equal(url.searchParams.get("year"), "2025");
    assert.equal(url.searchParams.get("region"), "美国");
    assert.equal(url.searchParams.get("sort"), "time");
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.get("pageSize"), "30");
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify({
        code: 200,
        data: [
          {
            name: "筛选结果",
            data: [
              {
                id: "latest-1",
                title: "最新影片",
                rate: "7.9",
                cover: "https://image.example/latest-1.jpg",
                url: "https://movie.example/latest-1",
              },
            ],
          },
        ],
        pagination: { page: 2, pageSize: 30, total: 80, hasMore: true },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await getContentCatalog(
      new NextRequest(
        "http://localhost/api/content/catalog?view=latest&genre=%E7%A7%91%E5%B9%BB&year=2025&region=%E7%BE%8E%E5%9B%BD&sort=release-date&page=2&limit=30"
      )
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.filters, {
      genre: "科幻",
      year: "2025",
      region: "美国",
      sort: "release-date",
    });
    assert.deepEqual(body.data.pagination, {
      page: 2,
      limit: 30,
      total: 80,
      hasMore: true,
    });
    assert.equal(body.data.items[0].title, "最新影片");
    assert.equal("source" in body.data.items[0], false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("catalog host rejects provider-specific or invalid browse parameters", async () => {
  const invalidUrls = [
    "http://localhost/api/content/catalog?view=sections&key=tv",
    "http://localhost/api/content/catalog?view=latest&sort=time",
    "http://localhost/api/content/catalog?view=latest&tag=provider-token",
    "http://localhost/api/content/catalog?view=sections&key=movies&genre=%E5%8A%A8%E4%BD%9C",
  ];

  for (const url of invalidUrls) {
    const response = await getContentCatalog(new NextRequest(url));
    assert.equal(response.status, 400, url);
  }
});
