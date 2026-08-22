import assert from "node:assert/strict";
import test from "node:test";

import {
  getPlaybackResources,
  normalizeDanmuEvents,
  normalizeImageCandidates,
  normalizePlaybackResources,
  normalizeRecommendationCandidates,
} from "@/lib/plugins/media-host";
import type {
  ImageRequest,
  PlaybackRequest,
  RecommendationRequest,
} from "@/lib/plugins/types";

const CONTENT_ID = "11111111-1111-4111-8111-111111111111";
const content = {
  contentId: CONTENT_ID,
  externalRefs: [{ providerId: "example.content", externalId: "movie-1" }],
};
const provenance = {
  source: { providerId: "example.media" },
  pluginVersion: "1.0.0",
  fetchedAt: "2026-08-23T00:00:00.000Z",
};

const playbackRequest: PlaybackRequest = { content };
const imageRequest: ImageRequest = { content, purpose: "poster" };
const recommendationRequest: RecommendationRequest = { content, limit: 2 };

test("playback normalization filters expired URLs and removes duplicates", async () => {
  const result = await normalizePlaybackResources(
    [
      {
        kind: "playback",
        providerId: "example.playback",
        externalId: "stream-1",
        title: "1080p",
        url: "https://203.0.113.10/video.m3u8",
        availability: "available",
        provenance,
      },
      {
        kind: "playback",
        providerId: "example.playback",
        externalId: "stream-1",
        title: "duplicate",
        url: "https://203.0.113.10/video.m3u8",
        availability: "available",
        provenance,
      },
      {
        kind: "playback",
        providerId: "example.playback",
        externalId: "expired",
        title: "expired",
        url: "https://203.0.113.10/expired.m3u8",
        availability: "available",
        expiresAt: "2020-01-01T00:00:00.000Z",
        provenance,
      },
    ],
    playbackRequest
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.externalId, "stream-1");
});

test("playback host facade fails closed when the active profile has no provider", async () => {
  await assert.rejects(
    getPlaybackResources(playbackRequest),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "CAPABILITY_UNAVAILABLE"
  );
});

test("playback normalization rejects private or mismatched resources", async () => {
  await assert.rejects(
    normalizePlaybackResources(
      [{
        kind: "playback",
        contentId: CONTENT_ID,
        providerId: "example.playback",
        externalId: "private",
        title: "private",
        url: "http://127.0.0.1/video.m3u8",
        availability: "available",
        provenance,
      }],
      playbackRequest
    ),
    /blocked|不安全|Outbound/i
  );
  await assert.rejects(
    normalizePlaybackResources(
      [{
        kind: "playback",
        contentId: "22222222-2222-4222-8222-222222222222",
        providerId: "example.playback",
        externalId: "wrong-content",
        title: "wrong",
        url: "https://203.0.113.10/video.m3u8",
        availability: "available",
        provenance,
      }],
      playbackRequest
    ),
    /content_id/
  );
});

test("danmu normalization sorts events and deduplicates exact repeats", () => {
  const result = normalizeDanmuEvents([
    { timeMs: 2000, text: "second", mode: "scroll" },
    { timeMs: 1000, text: "first", mode: "bottom" },
    { timeMs: 1000, text: "first", mode: "bottom" },
  ]);
  assert.deepEqual(result.map((item) => item.timeMs), [1000, 2000]);
  assert.equal(result.length, 2);
});

test("danmu normalization rejects invalid timestamps", () => {
  assert.throws(
    () => normalizeDanmuEvents([{ timeMs: -1, text: "invalid" }]),
    /时间|timeMs/
  );
});

test("image normalization requires the requested content identity and safe URLs", async () => {
  const result = await normalizeImageCandidates(
    [{
      contentId: CONTENT_ID,
      purpose: "poster",
      url: "https://203.0.113.10/poster.jpg",
      width: 500,
      height: 750,
      provenance,
    }],
    imageRequest
  );
  assert.equal(result[0]?.contentId, CONTENT_ID);
  assert.equal(result[0]?.width, 500);

  await assert.rejects(
    normalizeImageCandidates(
      [{
        contentId: "22222222-2222-4222-8222-222222222222",
        purpose: "poster",
        url: "https://203.0.113.10/poster.jpg",
        provenance,
      }],
      imageRequest
    ),
    /content_id/
  );
});

test("recommendation normalization enforces an identity and a stable limit", () => {
  const result = normalizeRecommendationCandidates(
    [
      { contentId: "22222222-2222-4222-8222-222222222222", score: 0.9, provenance },
      { contentId: "22222222-2222-4222-8222-222222222222", score: 0.8, provenance },
      {
        externalRefs: [{ providerId: "example.content", externalId: "movie-3" }],
        score: 0.7,
        provenance,
      },
    ],
    recommendationRequest
  );
  assert.equal(result.length, 2);
  assert.equal(result[0]?.contentId, "22222222-2222-4222-8222-222222222222");
  assert.equal(result[1]?.externalRefs?.[0]?.externalId, "movie-3");
});
