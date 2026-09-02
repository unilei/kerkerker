/**
 * 导航「分类」菜单结构单测（纯数据，无网络/无 DB）
 *
 * 运行：npx tsx tests/tag-menu.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TAG_MENU_GROUPS,
  KNOWN_SOURCE_CATEGORIES,
} from "@/lib/short-drama/tag-menu";
import { mergeTagGroupSources } from "@/lib/short-drama/tag-groups";

const SNAPSHOT_CATEGORIES = mergeTagGroupSources(null, null).map(
  (group) => group.category
);

test("菜单组与源站分类一一对应（女频/男频/题材/爽点），单字标签不进菜单", () => {
  // 展示名是用户语感
  assert.deepEqual(
    TAG_MENU_GROUPS.map((group) => group.label),
    ["女频", "男频", "题材", "爽点"]
  );
  // sourceCategory 对齐源站快照分组，且不重复
  const sourceCategories = TAG_MENU_GROUPS.map((group) => group.sourceCategory);
  assert.equal(new Set(sourceCategories).size, sourceCategories.length);
  for (const category of sourceCategories) {
    assert.ok(SNAPSHOT_CATEGORIES.includes(category), `未知源站分类: ${category}`);
  }
  // 「单字标签」刻意隐藏
  assert.ok(sourceCategories.includes("单字标签") === false);
  assert.deepEqual(KNOWN_SOURCE_CATEGORIES, [...sourceCategories, "单字标签"]);
});

test("KNOWN_SOURCE_CATEGORIES 覆盖快照全部分类（水合时能识别新增组）", () => {
  for (const category of SNAPSHOT_CATEGORIES) {
    assert.ok(
      KNOWN_SOURCE_CATEGORIES.includes(category),
      `快照分类 ${category} 未纳入 KNOWN_SOURCE_CATEGORIES，会被当作新增组尾随展示`
    );
  }
});
