import { ObjectId } from "mongodb";

/**
 * 前台列表游标（keyset 分页）
 *
 * 「加载更多」以上一页最后一条为锚点取其后内容，与 offset 分页不同：
 * 翻页期间后台持续写入（新剧插入最前 / updated_at 变动）不会造成跨页
 * 重复或漏项。锚点 = 前台排序全序的三个键：
 *
 *   publish_date DESC → created_at DESC → _id DESC
 *
 * 其中 publish_date/created_at 可缺失（MongoDB 排序按 null 处理，
 * null < 字符串，DESC 时排在有值文档之后），_id 唯一保证全序无并列。
 * 服务端（SSR/接口）负责编解码，客户端只原样回传游标字符串。
 */

/** 游标载荷：p/c 缺失表示该锚点文档对应字段缺失（无日期尾部区） */
export interface ListCursor {
  /** publish_date */
  p?: string;
  /** created_at */
  c?: string;
  /** _id 十六进制串 */
  i: string;
}

/** 从列表条目（ShortDrama 视图，id 即 _id 十六进制）取游标锚点 */
export function listCursorFromDoc(doc: {
  id: string;
  publish_date?: string;
  created_at?: string;
}): ListCursor {
  return {
    i: doc.id,
    ...(doc.publish_date ? { p: doc.publish_date } : {}),
    ...(doc.created_at ? { c: doc.created_at } : {}),
  };
}

export function encodeListCursor(cursor: ListCursor): string {
  const compact = {
    ...(cursor.p ? { p: cursor.p } : {}),
    ...(cursor.c ? { c: cursor.c } : {}),
    i: cursor.i,
  };
  return Buffer.from(JSON.stringify(compact), "utf8").toString("base64url");
}

/** 解码失败（非法 base64/JSON/_id）返回 null，调用方按 400 拒绝而非静默回页首 */
export function decodeListCursor(raw: string): ListCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      p?: unknown;
      c?: unknown;
      i?: unknown;
    };
    if (typeof parsed?.i !== "string" || !/^[0-9a-f]{24}$/i.test(parsed.i)) {
      return null;
    }
    return {
      ...(typeof parsed.p === "string" && parsed.p ? { p: parsed.p } : {}),
      ...(typeof parsed.c === "string" && parsed.c ? { c: parsed.c } : {}),
      i: parsed.i,
    };
  } catch {
    return null;
  }
}

/**
 * 「严格排在游标之后」的查询条件，序语义与前台排序
 * { publish_date: -1, created_at: -1, _id: -1 } 逐键对齐（含缺失值按
 * null 参与 DESC 排序的规则）。纯函数，供单测校验。
 */
export function shortDramaKeysetFilter(cursor: ListCursor): Record<string, unknown> {
  const afterId = { _id: { $lt: new ObjectId(cursor.i) } };
  // 锚点所在发布日期区：有值为等值匹配，无日期区 { null } 同时匹配缺失
  const sameDate = cursor.p ? { publish_date: cursor.p } : { publish_date: null };
  const or: Record<string, unknown>[] = [];

  if (cursor.p) {
    // 发布日期更小的一定在锚点之后
    or.push({ publish_date: { $lt: cursor.p } });
    // 无发布日期（缺失/空）排在所有有日期文档之后，整体属于"更后"区间
    or.push({ publish_date: null });
  }

  if (cursor.c) {
    // 同发布日期内 created_at 更小
    or.push({ $and: [sameDate, { created_at: { $lt: cursor.c } }] });
    // 同发布日期同 created_at：_id 唯一收尾，保证无并列
    or.push({ $and: [sameDate, { created_at: cursor.c }, afterId] });
  } else {
    // created_at 由入库路径 $setOnInsert 保证存在，此分支仅兜底
    or.push({ $and: [sameDate, afterId] });
  }

  return { $or: or };
}
