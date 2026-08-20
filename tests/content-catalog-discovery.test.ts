import assert from "node:assert/strict";
import test from "node:test";

import { scanContentCatalogPages } from "@/lib/pan/catalog-sync";
import type { ContentCatalogCandidate } from "@/lib/plugins/types";

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
