import assert from "node:assert/strict";
import test from "node:test";

import {
  EN_DEFAULT_PROFILE_ID,
  pluginProfileRegistry,
} from "@/lib/plugins/builtin-profiles";
import { pluginRegistry } from "@/lib/plugins/builtin";
import { createPluginContext } from "@/lib/plugins/context";
import {
  TMDB_CONTENT_PLUGIN_ID,
  tmdbContentPlugin,
} from "@/lib/plugins/adapters/tmdb-content";

function context() {
  return createPluginContext({
    profileId: EN_DEFAULT_PROFILE_ID,
    requestId: "tmdb-plugin-test",
    timeoutMs: 5_000,
    config: {
      baseUrl: "https://api.themoviedb.org/3",
      imageBase: "https://image.tmdb.org/t/p/w500",
    },
    secrets: { apiKey: "test-read-token" },
  });
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("TMDB search uses the server-only bearer secret and normalizes movie and TV results", async () => {
  const previousFetch = globalThis.fetch;
  let requestUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") || "";
    return response({
      page: 1,
      total_pages: 2,
      total_results: 2,
      results: [
        {
          id: 603,
          media_type: "movie",
          title: "The Matrix",
          overview: "A computer hacker learns the truth.",
          poster_path: "/matrix.jpg",
          vote_average: 8.2,
          release_date: "1999-03-30",
        },
        {
          id: 1399,
          media_type: "tv",
          name: "Game of Thrones",
          poster_path: "/got.jpg",
          first_air_date: "2011-04-17",
        },
      ],
    });
  };
  try {
    const page = await tmdbContentPlugin.capabilities["content.search"]!.search(
      context(),
      { query: "matrix", limit: 10 }
    );
    assert.equal(new URL(requestUrl).pathname, "/3/search/multi");
    assert.equal(new URL(requestUrl).searchParams.get("api_key"), null);
    assert.equal(new URL(requestUrl).searchParams.get("language"), "en-US");
    assert.equal(authorization, "Bearer test-read-token");
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]?.externalRefs[0]?.providerId, TMDB_CONTENT_PLUGIN_ID);
    assert.equal(page.items[0]?.type, "movie");
    assert.equal(page.items[1]?.type, "series");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("TMDB detail and image capabilities map credits, images, and stable provider IDs", async () => {
  const previousFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    return response({
      id: 603,
      title: "The Matrix",
      overview: "A computer hacker learns the truth.",
      poster_path: "/matrix.jpg",
      backdrop_path: "/matrix-backdrop.jpg",
      vote_average: 8.2,
      release_date: "1999-03-30",
      runtime: 136,
      genres: [{ id: 28, name: "Action" }],
      production_countries: [{ iso_3166_1: "US" }],
      credits: {
        crew: [{ id: 1, name: "Lana Wachowski", job: "Director" }],
        cast: [{ id: 2, name: "Keanu Reeves" }],
      },
      images: {
        posters: [{ file_path: "/matrix.jpg", width: 500, height: 750 }],
        backdrops: [{ file_path: "/matrix-backdrop.jpg", width: 1280, height: 720 }],
      },
      recommendations: { results: [] },
    });
  };
  try {
    const receivedContext = context();
    const detail = await tmdbContentPlugin.capabilities["content.detail"]!.detail(
      receivedContext,
      { externalRef: { providerId: TMDB_CONTENT_PLUGIN_ID, externalId: "603" } }
    );
    assert.equal(detail?.externalRefs[0]?.canonicalUrl, "https://www.themoviedb.org/movie/603");
    assert.deepEqual(detail?.details.genres, ["Action"]);
    assert.deepEqual(detail?.details.directors, ["Lana Wachowski"]);
    assert.deepEqual(detail?.details.actors, ["Keanu Reeves"]);
    assert.equal(detail?.details.duration, "136 分钟");
    assert.equal(detail?.details.photos?.length, 2);

    const images = await tmdbContentPlugin.capabilities["asset.image"]!.image(
      receivedContext,
      {
        content: {
          contentId: "content_01",
          externalRefs: [{ providerId: TMDB_CONTENT_PLUGIN_ID, externalId: "603" }],
        },
        purpose: "poster",
      }
    );
    assert.equal(images[0]?.contentId, "content_01");
    assert.equal(images[0]?.purpose, "poster");
    assert.match(images[0]?.url || "", /image\.tmdb\.org\/t\/p\/w500\/matrix\.jpg$/);
    assert.deepEqual(paths, ["/3/movie/603", "/3/movie/603"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("TMDB catalog maps latest-series discovery and paging", async () => {
  const previousFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return response({
      page: 1,
      total_pages: 3,
      total_results: 45,
      results: [{
        id: 1399,
        media_type: "tv",
        name: "Game of Thrones",
        first_air_date: "2011-04-17",
        poster_path: "/got.jpg",
      }],
    });
  };
  try {
    const page = await tmdbContentPlugin.capabilities["content.catalog"]!.catalog(
      context(),
      {
        view: "latest",
        cursor: "1",
        limit: 12,
        filters: { contentType: "series", sort: "release-date" },
      }
    );
    const url = new URL(requestUrl);
    assert.equal(url.pathname, "/3/discover/tv");
    assert.equal(url.searchParams.get("sort_by"), "first_air_date.desc");
    assert.match(url.searchParams.get("first_air_date.lte") || "", /^20\d\d-\d\d-\d\d$/);
    assert.equal(url.searchParams.get("language"), "en-US");
    assert.equal(page.total, 45);
    assert.equal(page.nextCursor, "2");
    assert.equal(page.hasMore, true);
    assert.equal(page.items[0]?.type, "series");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("TMDB calendar stays on the TMDB source and preserves the date window", async () => {
  const previousFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return response({
      page: 1,
      total_pages: 1,
      total_results: 1,
      results: [{
        id: 1399,
        media_type: "tv",
        name: "Game of Thrones",
        first_air_date: "2026-08-21",
        poster_path: "/got.jpg",
        backdrop_path: "/got-backdrop.jpg",
        vote_average: 8.7,
      }],
    });
  };
  try {
    const page = await tmdbContentPlugin.capabilities["content.calendar"]!.calendar(
      context(),
      { from: "2026-08-20", to: "2026-08-26", region: "US" }
    );
    const url = new URL(requestUrl);
    assert.equal(url.pathname, "/3/discover/tv");
    assert.equal(url.searchParams.get("air_date.gte"), "2026-08-20");
    assert.equal(url.searchParams.get("air_date.lte"), "2026-08-26");
    assert.equal(url.searchParams.get("with_origin_country"), "US");
    assert.equal(page.items[0]?.calendar.airDate, "2026-08-21");
    assert.equal(page.items[0]?.calendar.eventId, "1399:2026-08-21:1:1");
    assert.equal(page.items[0]?.calendar.seasonNumber, 1);
    assert.equal(page.items[0]?.calendar.episodeNumber, 1);
    assert.equal(page.items[0]?.externalRefs[0]?.providerId, TMDB_CONTENT_PLUGIN_ID);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("en-default is TMDB-only while cn-default remains Douban-bound", () => {
  assert.deepEqual(
    pluginProfileRegistry.getPluginIds(EN_DEFAULT_PROFILE_ID, "content.search"),
    [TMDB_CONTENT_PLUGIN_ID]
  );
  assert.deepEqual(
    pluginProfileRegistry.getPluginIds("cn-default", "content.search"),
    ["kerkerker.douban-content"]
  );
  assert.ok(pluginRegistry.get(TMDB_CONTENT_PLUGIN_ID));
});
