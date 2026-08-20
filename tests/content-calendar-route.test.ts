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
