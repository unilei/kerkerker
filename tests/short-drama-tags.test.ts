/**
 * 标签归类映射单测（无网络，快照兜底逻辑）
 *
 * 运行：npx tsx tests/short-drama-tags.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeTagGroupSources,
  flattenTagGroups,
} from "@/lib/short-drama/tag-groups";

test("mergeTagGroupSources：无 DB 无 live 时用构建期快照（五组齐全）", () => {
  const groups = mergeTagGroupSources(null, null);
  assert.deepEqual(
    groups.map((group) => group.category),
    ["女性标签", "男性标签", "场景职业", "爽设标签", "单字标签"]
  );
  // 快照总数 72（2026-08-31 抓取）
  const total = groups.reduce((sum, group) => sum + group.tags.length, 0);
  assert.equal(total, 72);
});

test("mergeTagGroupSources：live 覆盖同组标签，缺组用快照兜底", () => {
  const live = {
    女性标签: ["娇妻", "新标签"],
    新分组: ["跨组词"],
  };
  const groups = mergeTagGroupSources(null, live);
  const byCategory = new Map(groups.map((group) => [group.category, group.tags]));
  // live 的女性标签生效
  assert.deepEqual(byCategory.get("女性标签"), ["娇妻", "新标签"]);
  // 快照兜底组仍在
  assert.ok(byCategory.has("男性标签"));
  assert.ok(byCategory.has("场景职业"));
  assert.ok(byCategory.has("爽设标签"));
  assert.ok(byCategory.has("单字标签"));
  // 新分组按序尾随
  assert.deepEqual(byCategory.get("新分组"), ["跨组词"]);
  assert.deepEqual(
    groups.map((group) => group.category).slice(-1),
    ["新分组"]
  );
});

test("mergeTagGroupSources：stored 优先级低于 live、高于快照", () => {
  const stored = { 男性标签: ["老公"] };
  const live = { 男性标签: ["王爷"] };
  const byCategory = new Map(
    mergeTagGroupSources(stored, live).map((group) => [group.category, group.tags])
  );
  assert.deepEqual(byCategory.get("男性标签"), ["王爷"]);
});

test("flattenTagGroups：同标签多组时先出现者优先", () => {
  const mapping = flattenTagGroups([
    { category: "A组", tags: ["共享词"] },
    { category: "B组", tags: ["共享词", "独有词"] },
  ]);
  assert.equal(mapping.get("共享词"), "A组");
  assert.equal(mapping.get("独有词"), "B组");
});
