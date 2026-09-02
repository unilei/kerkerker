/**
 * 前台列表游标单元测试（无外部依赖，纯函数校验）
 *
 * 运行：npx tsx tests/list-cursor.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";

import {
  decodeListCursor,
  encodeListCursor,
  listCursorFromDoc,
  shortDramaKeysetFilter,
  type ListCursor,
} from "@/lib/list-cursor";

// ---------------------------------------------------------------------------
// 游标编解码
// ---------------------------------------------------------------------------

test("listCursor 编解码往返：完整字段", () => {
  const cursor: ListCursor = { p: "2026-08-31", c: "2026-08-31T10:00:00.000Z", i: "6a967898f18b06ffd9ecdc16" };
  const decoded = decodeListCursor(encodeListCursor(cursor));
  assert.deepEqual(decoded, cursor);
});

test("listCursor 编解码往返：缺失日期（无日期尾部区锚点）", () => {
  const cursor: ListCursor = { i: "6a967898f18b06ffd9ecdc16" };
  assert.deepEqual(decodeListCursor(encodeListCursor(cursor)), cursor);
});

test("listCursorFromDoc：缺失字段不进游标", () => {
  assert.deepEqual(
    listCursorFromDoc({ id: "6a967898f18b06ffd9ecdc16", publish_date: "2026-01-01", created_at: "2026-01-01T00:00:00.000Z" }),
    { p: "2026-01-01", c: "2026-01-01T00:00:00.000Z", i: "6a967898f18b06ffd9ecdc16" }
  );
  assert.deepEqual(listCursorFromDoc({ id: "6a967898f18b06ffd9ecdc16" }), { i: "6a967898f18b06ffd9ecdc16" });
});

test("decodeListCursor：非法输入一律返回 null", () => {
  assert.equal(decodeListCursor("not-base64url!!"), null);
  assert.equal(decodeListCursor(Buffer.from("not-json").toString("base64url")), null);
  assert.equal(decodeListCursor(Buffer.from(JSON.stringify({})).toString("base64url")), null);
  assert.equal(
    decodeListCursor(Buffer.from(JSON.stringify({ i: "zzzz" })).toString("base64url")),
    null
  );
  // 非字符串 p/c 被剔除，i 合法则通过
  assert.deepEqual(
    decodeListCursor(Buffer.from(JSON.stringify({ p: 1, c: {}, i: "6a967898f18b06ffd9ecdc16" })).toString("base64url")),
    { i: "6a967898f18b06ffd9ecdc16" }
  );
});

// ---------------------------------------------------------------------------
// keyset 过滤器 ↔ 排序语义对齐
//
// 用一个模拟 MongoDB 行为的小型求值器验证：shortDramaKeysetFilter(锚点)
// 选出的文档集合 = 按前台全序排序后「严格排在锚点之后」的文档。
// 全序：publish_date DESC → created_at DESC → _id DESC，
// 缺失字段按 null 参与（null < 字符串，DESC 时排末尾）。
// ---------------------------------------------------------------------------

/** 24 位十六进制伪 ObjectId（字典序 = 字节序） */
function fakeId(n: number): string {
  return n.toString(16).padStart(24, "0");
}

// 文档字段只会被过滤器的三个排序键索引，索引用字符串放宽即可
interface Doc {
  [key: string]: string | undefined;
  _id: string;
  publish_date?: string;
  created_at?: string;
}

/** 模拟 Mongo 前台排序：DESC 三键，null（缺失）排末尾 */
function compareDesc(a: Doc, b: Doc): number {
  for (const key of ["publish_date", "created_at"] as const) {
    const av = a[key] ?? null;
    const bv = b[key] ?? null;
    if (av === null && bv === null) continue;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return av < bv ? 1 : -1;
  }
  return a._id < b._id ? 1 : a._id > b._id ? -1 : 0;
}

/** 极简 Mongo 查询问值器：只支持过滤器用到的 $or/$and/$lt/等值/null 等值 */
function matches(cond: Record<string, unknown>, doc: Doc): boolean {
  return Object.entries(cond).every(([key, value]) => {
    if (key === "$or") return (value as Record<string, unknown>[]).some((c) => matches(c, doc));
    if (key === "$and") return (value as Record<string, unknown>[]).every((c) => matches(c, doc));
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).every(([op, arg]) => {
        if (op !== "$lt") throw new Error(`测试求值器不支持操作符 ${op}`);
        const dv = doc[key];
        // Mongo 范围操作符不匹配缺失/null；_id 存 ObjectId，比较用十六进制
        if (dv == null) return false;
        const argHex = arg instanceof ObjectId ? arg.toHexString() : (arg as string);
        return dv < argHex;
      });
    }
    // 等值：null 同时匹配缺失与 null（Mongo 语义）
    if (value === null) return doc[key] == null;
    if (value instanceof ObjectId) return doc[key] === value.toHexString();
    return doc[key] === value;
  });
}

/** 混合场景：有/无发布日期、同日期不同 created_at、同日期同 created_at 并列 */
const DOCS: Doc[] = [
  { _id: fakeId(1), publish_date: "2026-08-31", created_at: "2026-08-31T12:00:00.000Z" },
  { _id: fakeId(2), publish_date: "2026-08-31", created_at: "2026-08-31T09:00:00.000Z" },
  { _id: fakeId(3), publish_date: "2026-08-31", created_at: "2026-08-31T09:00:00.000Z" },
  { _id: fakeId(4), publish_date: "2026-08-30", created_at: "2026-09-01T00:00:00.000Z" },
  { _id: fakeId(5), publish_date: "2026-08-30", created_at: "2026-08-01T00:00:00.000Z" },
  // 无发布日期（缺失），按 null 排全序末尾，区内按 created_at/_id
  { _id: fakeId(6), created_at: "2026-07-01T00:00:00.000Z" },
  { _id: fakeId(7), created_at: "2026-06-01T00:00:00.000Z" },
  { _id: fakeId(8), created_at: "2026-06-01T00:00:00.000Z" },
  { _id: fakeId(9), publish_date: "2026-09-01", created_at: "2026-09-01T00:00:00.000Z" },
  { _id: fakeId(10), publish_date: "2026-07-15", created_at: "2026-07-15T00:00:00.000Z" },
];

test("keyset 过滤器与前台全序逐锚点对齐：每个位置的后继集合不重不漏", () => {
  const sorted = [...DOCS].sort(compareDesc);
  for (let k = 0; k < sorted.length; k++) {
    const anchor = sorted[k];
    const cursor = listCursorFromDoc({
      id: anchor._id,
      publish_date: anchor.publish_date,
      created_at: anchor.created_at,
    });
    const filter = shortDramaKeysetFilter(cursor);
    const got = DOCS.filter((doc) => matches(filter, doc)).sort(compareDesc);
    const expected = sorted.slice(k + 1);
    assert.deepEqual(
      got.map((d) => d._id),
      expected.map((d) => d._id),
      `锚点 #${anchor._id}（${anchor.publish_date ?? "无日期"}）的后继集合不符`
    );
  }
});

test("keyset 过滤器：空尾锚点（无日期文档）后继为空集", () => {
  const sorted = [...DOCS].sort(compareDesc);
  const last = sorted[sorted.length - 1];
  const filter = shortDramaKeysetFilter(listCursorFromDoc({ id: last._id, created_at: last.created_at }));
  assert.equal(DOCS.filter((doc) => matches(filter, doc)).length, 0);
});
