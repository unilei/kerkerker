import assert from "node:assert/strict";
import test from "node:test";

import {
  canAutoMergeKkpanGroup,
  resolveKkpanIdentity,
  sortKkpanGroupForRetention,
} from "@/lib/pan/dedup-policy";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import type { PanResourceDoc } from "@/lib/pan-resources-db";

const CONTENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function resource(overrides: Partial<PanResourceDoc> = {}): PanResourceDoc {
  return {
    douban_id: "1292052",
    content_id: CONTENT_ID,
    brand: "quark",
    title: "资源",
    url: "https://example.com/resource",
    source: "manual",
    enabled: true,
    created_at: "2026-08-19T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

test("recovers a missing legacy kkpan_id from the canonical provider pair", () => {
  const result = resolveKkpanIdentity(resource({
    provider_id: KKPAN_PLUGIN_ID,
    provider_resource_id: "123",
  }));

  assert.deepEqual(result, {
    kind: "kkpan",
    kkpanId: 123,
    pair: { providerId: KKPAN_PLUGIN_ID, providerResourceId: "123" },
  });
});

test("rejects conflicting legacy and canonical KKPAN IDs", () => {
  const result = resolveKkpanIdentity(resource({
    kkpan_id: 123,
    source: "kkpan",
    provider_id: KKPAN_PLUGIN_ID,
    provider_resource_id: "456",
  }));

  assert.equal(result.kind, "conflict");
  if (result.kind === "conflict") assert.match(result.reason, /不一致/);
});

test("rejects source=kkpan when no stable source ID can be recovered", () => {
  const result = resolveKkpanIdentity(resource({ source: "kkpan", kkpan_id: 0 }));

  assert.equal(result.kind, "conflict");
  if (result.kind === "conflict") assert.match(result.reason, /没有可恢复/);
});

test("does not merge duplicate KKPAN rows without a shared valid movie identity", () => {
  const first = resource({ douban_id: 123 as unknown as string, content_id: undefined });
  const second = resource({ douban_id: 456 as unknown as string, content_id: undefined });

  assert.equal(canAutoMergeKkpanGroup([first, second]), false);
});

test("accepts a shared valid anchor but rejects any conflicting known anchor", () => {
  const first = resource();
  const compatible = resource({ content_id: undefined });
  const conflicting = resource({ content_id: "550e8400-e29b-41d4-a716-446655440001" });

  assert.equal(canAutoMergeKkpanGroup([first, compatible]), true);
  assert.equal(canAutoMergeKkpanGroup([first, conflicting]), false);
});

test("retention keeps the newest row after losers have been backed up", () => {
  const canonical = resource({
    title: "canonical",
    kkpan_id: 123,
    source: "kkpan",
    provider_id: KKPAN_PLUGIN_ID,
    provider_resource_id: "123",
    updated_at: "2026-08-19T00:00:00.000Z",
  });
  const newer = resource({
    title: "newer",
    kkpan_id: 123,
    source: "kkpan",
    updated_at: "2026-08-20T00:00:00.000Z",
  });

  assert.equal(sortKkpanGroupForRetention([newer, canonical])[0]?.title, "newer");
});
