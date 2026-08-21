import assert from "node:assert/strict";
import test from "node:test";

import {
  preparePanSyncTargetInputs,
  scanContentCatalogPages,
  upsertPanSyncTargets,
} from "@/lib/pan/catalog-sync";
import type { ContentCatalogCandidate } from "@/lib/plugins/types";

const CONTENT_ID_A = "550e8400-e29b-41d4-a716-446655440000";
const CONTENT_ID_B = "550e8400-e29b-41d4-a716-446655440001";

function candidate(id: string): ContentCatalogCandidate {
  return {
    type: "movie",
    externalRefs: [{ providerId: "test.content", externalId: id }],
    titles: [{ locale: "zh-CN", value: `影片 ${id}` }],
    provenance: {
      source: { providerId: "test.content" },
      pluginVersion: "1.0.0",
      fetchedAt: "2026-08-20T00:00:00.000Z",
    },
  };
}

test("catalog discovery follows opaque cursors without assuming page numbers", async () => {
  const seen: Array<string | undefined> = [];
  const result = await scanContentCatalogPages(async (cursor) => {
    seen.push(cursor);
    if (!cursor) {
      return { items: [candidate("1")], hasMore: true, nextCursor: "opaque:next" };
    }
    return { items: [candidate("2")], hasMore: false };
  });

  assert.deepEqual(seen, [undefined, "opaque:next"]);
  assert.deepEqual(result.items.map((item) => item.externalRefs[0]?.externalId), ["1", "2"]);
  assert.equal(result.error, undefined);
});

test("catalog discovery rejects hasMore without a next cursor and keeps partial items", async () => {
  const result = await scanContentCatalogPages(async () => ({
    items: [candidate("1")],
    hasMore: true,
  }));

  assert.equal(result.items.length, 1);
  assert.match(result.error || "", /nextCursor/);
});

test("catalog discovery stops repeated cursors before an infinite loop", async () => {
  let calls = 0;
  const result = await scanContentCatalogPages(async () => {
    calls++;
    return {
      items: [candidate(String(calls))],
      hasMore: true,
      nextCursor: "same-cursor",
    };
  });

  assert.equal(calls, 2);
  assert.equal(result.items.length, 2);
  assert.match(result.error || "", /重复/);
});

test("pan sync target preparation resolves content_id when the caller omits it", async () => {
  const resolved: string[] = [];
  const targets = await preparePanSyncTargetInputs(
    [{ douban_id: "1292052", title: "测试影片" }],
    async (doubanId) => {
      resolved.push(doubanId);
      return CONTENT_ID_A;
    }
  );

  assert.deepEqual(resolved, ["1292052"]);
  assert.equal(targets[0]?.content_id, CONTENT_ID_A);
});

test("pan sync target preparation rejects a caller content_id that disagrees with Douban identity", async () => {
  await assert.rejects(
    () =>
      preparePanSyncTargetInputs(
        [{
          douban_id: "1292052",
          content_id: CONTENT_ID_B,
          title: "测试影片",
        }],
        async () => CONTENT_ID_A
      ),
    /content_id 与影片外部引用不一致/
  );
});

test("pan sync target mismatch is rejected before bulkWrite can begin", async () => {
  const previousMongoUri = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    await assert.rejects(
      () =>
        upsertPanSyncTargets(
          [
            { douban_id: "1292052", title: "合法影片" },
            {
              douban_id: "1292053",
              content_id: CONTENT_ID_B,
              title: "伪造影片身份",
            },
          ],
          async (doubanId) =>
            doubanId === "1292052" ? CONTENT_ID_A : CONTENT_ID_A
        ),
      /content_id 与影片外部引用不一致/
    );
  } finally {
    if (previousMongoUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousMongoUri;
  }
});
