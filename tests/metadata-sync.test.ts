/**
 * 元数据同步队列过滤器单元测试（无外部网络、无 MongoDB 依赖）
 *
 * 用一个最小 Mongo 查询匹配器在内存中验证
 * shortDramaMetadataSyncFilter 的语义：
 *  - published 且有分享链接；任一三件套字段值缺失（不存在或
 *    显式 null）且未被 missing_at_source 豁免的条目入队；
 *  - missing_at_source 命中任一部件即豁免该部件（数组语义 $ne）；
 *  - 有值字段不触发。
 *
 * 运行：npx tsx tests/metadata-sync.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { shortDramaMetadataSyncFilter } from "@/lib/short-drama-db";

/** 匹配单字段条件（supports $exists / $ne / $type / 相等）；缺省 = 字段必须存在 */
function matchesField(doc: Record<string, unknown>, field: string, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
    const ops = cond as Record<string, unknown>;
    for (const [op, arg] of Object.entries(ops)) {
      const has = field in doc && doc[field] !== undefined;
      const value = doc[field];
      switch (op) {
        case "$exists":
          if (Boolean(arg) !== has) return false;
          break;
        case "$ne":
          // Mongo 语义：字段缺失也算命中 $ne（不等于给定的值）
          if (has && mongoEquals(value, arg)) return false;
          break;
        case "$type":
          if (!has || typeof value !== String(arg)) return false;
          break;
        case "$in":
          if (!has || !(arg as unknown[]).some((item) => mongoEquals(value, item))) return false;
          break;
        default:
          throw new Error(`测试匹配器不支持操作符: ${op}`);
      }
    }
    return true;
  }
  return mongoEquals(doc[field], cond);
}

/**
 * Mongo 相等语义：存储值是数组时，「等于」= 任一元素相等
 * （{arr: {$ne: "x"}} 对含 "x" 的数组不匹配）；null 同时匹配缺失与 null
 */
function mongoEquals(stored: unknown, expected: unknown): boolean {
  if (Array.isArray(stored)) return stored.some((item) => mongoEquals(item, expected));
  if (expected === null) return stored === undefined || stored === null;
  return JSON.stringify(stored) === JSON.stringify(expected);
}

/** 匹配完整查询（supports $and / $or / 字段级条件） */
function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(query)) {
    if (key === "$and") {
      if (!(cond as Record<string, unknown>[]).every((sub) => matches(doc, sub))) return false;
    } else if (key === "$or") {
      if (!(cond as Record<string, unknown>[]).some((sub) => matches(doc, sub))) return false;
    } else {
      if (!matchesField(doc, key, cond)) return false;
    }
  }
  return true;
}

/** 迷你 doc 构造：published + 有分享链接的基线 */
function baseDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "published",
    share_url: "https://pan.quark.cn/s/x",
    ...extra,
  };
}

const filter = shortDramaMetadataSyncFilter();

test("元数据队列：三件套齐全不入队", () => {
  assert.equal(
    matches(baseDoc({ cover_url: "https://x/1.jpg", intro: "简介", metadata: { a: 1 } }), filter),
    false
  );
});

test("元数据队列：任一部件字段缺失即入队", () => {
  assert.equal(matches(baseDoc({ intro: "简介", metadata: { a: 1 } }), filter), true);
  assert.equal(matches(baseDoc({ cover_url: "https://x/1.jpg", metadata: { a: 1 } }), filter), true);
  assert.equal(matches(baseDoc({ cover_url: "https://x/1.jpg", intro: "简介" }), filter), true);
});

test("元数据队列：显式 null 等价于字段缺失（转存失败残留态）", () => {
  assert.equal(
    matches(baseDoc({ cover_url: null, intro: "简介", metadata: { a: 1 } }), filter),
    true
  );
  assert.equal(
    matches(baseDoc({ cover_url: "https://x/1.jpg", intro: "简介", metadata: null }), filter),
    true
  );
});

test("元数据队列：missing_at_source 豁免对应部件", () => {
  // 只缺 metadata 且 metadata 已标记源缺失 → 不入队
  assert.equal(
    matches(
      baseDoc({ cover_url: "https://x/1.jpg", intro: "简介", missing_at_source: ["metadata"] }),
      filter
    ),
    false
  );
  // 只缺 metadata 但标记的是 intro → 仍入队
  assert.equal(
    matches(
      baseDoc({ cover_url: "https://x/1.jpg", intro: "简介", missing_at_source: ["intro"] }),
      filter
    ),
    true
  );
});

test("元数据队列：多部件缺失，全部被豁免才出队", () => {
  // cover+metadata 都缺且都标记 → 出队
  assert.equal(
    matches(
      baseDoc({ intro: "简介", missing_at_source: ["cover", "metadata"] }),
      filter
    ),
    false
  );
  // cover 缺但未标记 → 入队
  assert.equal(
    matches(
      baseDoc({ cover_url: null, intro: "简介", missing_at_source: ["metadata"] }),
      filter
    ),
    true
  );
});

test("元数据队列：基础门槛（enabled/done/own_folder_fid）", () => {
  assert.equal(matches(baseDoc({ status: "offline" }), filter), false);
  assert.equal(matches(baseDoc({ share_url: null }), filter), false);
  });

test("元数据队列：空数组 missing_at_source 不豁免任何部件", () => {
  assert.equal(
    matches(baseDoc({ missing_at_source: [] }), filter),
    true
  );
});
