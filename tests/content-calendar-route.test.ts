import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET as getContentCalendar } from "@/app/api/content/calendar/route";

test("content calendar route preserves schedule metadata and Douban identity", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/api\/v1\/calendar\?/);
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify({
        start_date: "2026-08-20",
        end_date: "2026-08-26",
        total: 1,
        days: [
          {
            date: "2026-08-20",
            entries: [
              {
                show_id: 42,
                show_name: "Example Show",
                show_name_cn: "示例剧",
                season_number: 2,
                episode_number: 3,
                episode_name: "第三集",
                air_date: "2026-08-20",
                poster: "https://image.example/poster.jpg",
                backdrop: "https://image.example/backdrop.jpg",
                overview: "简介",
                vote_average: 8.8,
                douban_id: "1292052",
                douban_rating: "9.0",
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const response = await getContentCalendar(
      new NextRequest(
        "http://localhost/api/content/calendar?start_date=2026-08-20&end_date=2026-08-26&region=CN"
      )
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.total, 1);
    assert.equal(body.data.days[0].entries[0].show_id, 42);
    assert.equal(body.data.days[0].entries[0].event_id, "42:2026-08-20:2:3");
    assert.equal(body.data.days[0].entries[0].episode_number, 3);
    assert.equal(body.data.days[0].entries[0].poster, "https://image.example/poster.jpg");
    assert.equal(body.data.days[0].entries[0].douban_id, "1292052");
    assert.equal(body.data.days[0].entries[0].provider_id, "kerkerker.douban-content");
    assert.equal(body.data.days[0].entries[0].external_id, "1292052");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("content calendar route validates date range before plugin access", async () => {
  const previousFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("upstream should not be called");
  };
  try {
    const response = await getContentCalendar(
      new NextRequest(
        "http://localhost/api/content/calendar?start_date=2026-08-26&end_date=2026-08-20&region=CN"
      )
    );
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("content calendar route does not label non-Douban external IDs as douban_id", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        start_date: "2026-08-20",
        end_date: "2026-08-20",
        total: 1,
        days: [
          {
            date: "2026-08-20",
            entries: [
              {
                show_id: 99,
                show_name: "TMDB Show",
                season_number: 1,
                episode_number: 1,
                episode_name: "Pilot",
                air_date: "2026-08-20",
                poster: "",
                vote_average: 7,
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  try {
    const response = await getContentCalendar(
      new NextRequest("http://localhost/api/content/calendar?start_date=2026-08-20&end_date=2026-08-20")
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.days[0].entries[0].douban_id, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("en-default calendar uses TMDB without falling back to Douban", async () => {
  const previousFetch = globalThis.fetch;
  const previousProfile = process.env.KERKERKER_PLUGIN_PROFILE;
  const previousToken = process.env.TMDB_PLUGIN_SERVICE_TOKEN;
  process.env.KERKERKER_PLUGIN_PROFILE = "en-default";
  process.env.TMDB_PLUGIN_SERVICE_TOKEN = "test-plugin-token";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = { "x-kerkerker-contract-version": "1.0.0" };
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-plugin-token");
    if (url.pathname === "/plugin/v1/health") {
      return new Response(JSON.stringify({ status: "ready" }), { status: 200, headers });
    }
    assert.equal(url.pathname, "/plugin/v1/invoke");
    const body = JSON.parse(String(init?.body)) as { capability: string; operation: string; request: { from: string; to: string } };
    assert.equal(body.capability, "content.calendar");
    assert.equal(body.operation, "calendar");
    assert.equal(body.request.from, "2026-08-20");
    assert.equal(body.request.to, "2026-08-26");
    return new Response(
      JSON.stringify({
        items: [{
          type: "series",
          externalRefs: [{ providerId: "kerkerker.tmdb-content", externalId: "1399" }],
          titles: [{ locale: "en-US", value: "Game of Thrones" }],
          preview: { posterUrl: "https://image.example/got.jpg", rating: "8.7" },
          releaseDate: "2026-08-21",
          calendar: {
            eventId: "1399:2026-08-21:1:1",
            airDate: "2026-08-21",
            seasonNumber: 1,
            episodeNumber: 1,
            posterUrl: "https://image.example/got.jpg",
            rating: 8.7,
          },
          provenance: {
            source: { providerId: "kerkerker.tmdb-content" },
            pluginVersion: "1.0.0",
            fetchedAt: "2026-08-23T00:00:00Z",
          },
        }],
        total: 1,
        hasMore: false,
      }),
      { status: 200, headers: { ...headers, "content-type": "application/json" } }
    );
  };
  try {
    const response = await getContentCalendar(
      new NextRequest("http://localhost/api/content/calendar?start_date=2026-08-20&end_date=2026-08-26")
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.days[0].entries[0].provider_id, "kerkerker.tmdb-content");
    assert.equal(body.data.days[0].entries[0].douban_id, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProfile === undefined) delete process.env.KERKERKER_PLUGIN_PROFILE;
    else process.env.KERKERKER_PLUGIN_PROFILE = previousProfile;
    if (previousToken === undefined) delete process.env.TMDB_PLUGIN_SERVICE_TOKEN;
    else process.env.TMDB_PLUGIN_SERVICE_TOKEN = previousToken;
  }
});
