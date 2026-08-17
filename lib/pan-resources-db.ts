import { getDatabase } from "./db";
import { COLLECTIONS } from "./constants/db";
import { ObjectId, type Filter } from "mongodb";
import {
  PAN_BRANDS,
  type PanBrand,
  type PanResource,
  type PanResourceInput,
} from "@/types/pan-resource";

// 数据库文档类型（蛇形字段，与 collection 存储一致）
export interface PanResourceDoc {
  _id?: ObjectId;
  douban_id: string;
  internal_id?: number;
  movie_title?: string;
  brand: PanBrand;
  title: string;
  size?: string;
  format?: string;
  url: string;
  code?: string;
  note?: string;
  source?: "manual" | "kkpan";
  kkpan_id?: number;
  enabled: boolean;
  created_at: string; // ISO 字符串格式
  updated_at: string; // ISO 字符串格式
}

// 同步状态文档（pan_sync_state 集合，单例 id:1）
export interface PanSyncStateDoc {
  _id?: ObjectId;
  id: number;
  last_incremental_at?: string;
  last_backfill_at?: string;
  last_stats?: Record<string, unknown>;
  // 增量同步水位游标：上次同步最后处理的 kkpan_id。下次同步翻页时一旦遇到
  // 此 id 即停止（因为后续都是已处理过的旧资源），避免重复抓取。
  last_kkpan_watermark?: number;
  updated_at: string;
}

// 品牌排序权重（用于前台按固定品牌顺序展示）
const BRAND_ORDER: Record<string, number> = {};
PAN_BRANDS.forEach((brand, index) => {
  BRAND_ORDER[brand] = index;
});

// 将数据库文档转换为 PanResource 类型
function docToPanResource(doc: PanResourceDoc): PanResource {
  return {
    id: (doc._id as ObjectId).toString(),
    douban_id: doc.douban_id,
    internal_id: doc.internal_id,
    movie_title: doc.movie_title,
    brand: doc.brand,
    title: doc.title,
    size: doc.size,
    format: doc.format,
    url: doc.url,
    code: doc.code,
    note: doc.note,
    source: doc.source,
    kkpan_id: doc.kkpan_id,
    enabled: doc.enabled,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

// 获取某影片的启用网盘资源（前台展示，按品牌顺序 + 更新时间排序）
export async function getPanResourcesByDoubanId(
  doubanId: string
): Promise<PanResource[]> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  const docs = await collection
    .find({ douban_id: doubanId, enabled: true })
    .sort({ updated_at: -1 })
    .toArray();

  return docs
    .map(docToPanResource)
    .sort((a, b) => {
      const diff =
        (BRAND_ORDER[a.brand] ?? BRAND_ORDER.length) -
        (BRAND_ORDER[b.brand] ?? BRAND_ORDER.length);
      if (diff !== 0) return diff;
      return b.updated_at.localeCompare(a.updated_at);
    });
}

// 查询参数
export interface PanResourceQueryOptions {
  doubanId?: string;
  keyword?: string; // 按片名 / 资源名模糊搜索，或精确匹配豆瓣 ID
  limit?: number;
}

// 获取网盘资源列表（管理端，含禁用条目）
export async function getAllPanResources(
  options: PanResourceQueryOptions = {}
): Promise<PanResource[]> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  const filter: Filter<PanResourceDoc> = {};
  if (options.doubanId) {
    filter.douban_id = options.doubanId;
  }
  if (options.keyword) {
    filter.$or = [
      { movie_title: { $regex: options.keyword, $options: "i" } },
      { title: { $regex: options.keyword, $options: "i" } },
      { douban_id: options.keyword },
    ];
  }

  const docs = await collection
    .find(filter)
    .sort({ updated_at: -1 })
    .limit(options.limit ?? 50)
    .toArray();

  return docs.map(docToPanResource);
}

// 新增网盘资源。
// 幂等保证：当 input.source === "kkpan" 且带 kkpan_id 时，依赖 pan_resources
// 上 kkpan_id 的部分唯一索引保证同 kkpan_id 全局只有一条。并发同步撞到同一
// kkpan_id 时，后到的一次 insertOne 会抛 duplicate key（错误码 11000），本函数
// 捕获后回退为按 kkpan_id 查出现有文档返回，调用方通过 created=false 区分。
// 手工录入（无 kkpan_id）走原 insertOne 路径，不受唯一索引约束。
export async function createPanResourceInDB(
  input: Required<Pick<PanResourceInput, "douban_id" | "brand" | "title" | "url">> &
    PanResourceInput
): Promise<{ resource: PanResource; created: boolean }> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const now = new Date().toISOString();

  const doc: Omit<PanResourceDoc, "_id"> = {
    douban_id: input.douban_id,
    internal_id: input.internal_id,
    movie_title: input.movie_title,
    brand: input.brand,
    title: input.title,
    size: input.size,
    format: input.format,
    url: input.url,
    code: input.code,
    note: input.note,
    source: input.source,
    kkpan_id: input.kkpan_id,
    enabled: input.enabled ?? true,
    created_at: now,
    updated_at: now,
  };

  try {
    const result = await collection.insertOne(doc);
    return {
      resource: docToPanResource({ ...doc, _id: result.insertedId }),
      created: true,
    };
  } catch (err) {
    // 仅对 kkpan 来源 + 带 kkpan_id 的资源做 duplicate key 兜底；
    // 其它错误（如校验失败）继续抛。
    const code = (err as { code?: number; codeName?: string })?.code;
    const isDuplicate =
      code === 11000 ||
      (err as Error)?.message?.toLowerCase?.().includes("duplicate key");
    if (!(doc.source === "kkpan" && doc.kkpan_id != null && isDuplicate)) {
      throw err;
    }
    const existing = await collection.findOne({ kkpan_id: doc.kkpan_id });
    if (!existing) throw err; // 不应该走到，保守重抛
    return { resource: docToPanResource(existing), created: false };
  }
}

// 按 id 更新网盘资源（仅更新传入的字段）
export async function updatePanResourceInDB(
  id: string,
  updates: PanResourceInput
): Promise<PanResource | null> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const now = new Date().toISOString();

  const setDoc: Partial<PanResourceDoc> = { updated_at: now };
  if (updates.douban_id !== undefined) setDoc.douban_id = updates.douban_id;
  if (updates.internal_id !== undefined)
    setDoc.internal_id = updates.internal_id;
  if (updates.movie_title !== undefined)
    setDoc.movie_title = updates.movie_title;
  if (updates.brand !== undefined) setDoc.brand = updates.brand;
  if (updates.title !== undefined) setDoc.title = updates.title;
  if (updates.size !== undefined) setDoc.size = updates.size;
  if (updates.format !== undefined) setDoc.format = updates.format;
  if (updates.url !== undefined) setDoc.url = updates.url;
  if (updates.code !== undefined) setDoc.code = updates.code;
  if (updates.note !== undefined) setDoc.note = updates.note;
  if (updates.source !== undefined) setDoc.source = updates.source;
  if (updates.kkpan_id !== undefined) setDoc.kkpan_id = updates.kkpan_id;
  if (updates.enabled !== undefined) setDoc.enabled = updates.enabled;

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    return null;
  }

  const result = await collection.findOneAndUpdate(
    { _id: objectId },
    { $set: setDoc },
    { returnDocument: "after" }
  );

  return result ? docToPanResource(result) : null;
}

// 删除网盘资源
export async function deletePanResourceFromDB(id: string): Promise<boolean> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  try {
    const result = await collection.deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount > 0;
  } catch {
    return false;
  }
}

// 已存在资源的去重键（url 全集 + kkpan_id 全集），供同步去重
export async function getExistingPanKeys(): Promise<{
  urls: Set<string>;
  kkpanIds: Set<number>;
}> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  const [urls, kkpanIds] = await Promise.all([
    collection.distinct("url") as unknown as Promise<string[]>,
    collection.distinct("kkpan_id") as unknown as Promise<number[]>,
  ]);

  return {
    urls: new Set(urls.filter(Boolean)),
    kkpanIds: new Set(kkpanIds.filter((v) => typeof v === "number")),
  };
}

// kkpan 来源的资源（失效联动检测用），按更新时间倒序
export async function getKkpanSourceResources(limit = 200): Promise<PanResource[]> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  const docs = await collection
    .find({ source: "kkpan" as const })
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray();

  return docs.map(docToPanResource);
}

// 取当前库里 kkpan_id 的最大值，用于增量同步水位游标。
// 返回 undefined 表示库里还没有 kkpan 资源。
export async function getMaxKkpanId(): Promise<number | undefined> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const doc = await collection.findOne(
    { kkpan_id: { $gt: 0 } },
    { sort: { kkpan_id: -1 } }
  );
  return doc?.kkpan_id;
}

// ==================== 同步状态 ====================

// 读取同步状态（无则返回 null）
export async function getPanSyncState(): Promise<PanSyncStateDoc | null> {
  const db = await getDatabase();
  const collection = db.collection<PanSyncStateDoc>(COLLECTIONS.PAN_SYNC_STATE);
  return collection.findOne({ id: 1 });
}

// 更新同步状态
export async function savePanSyncState(patch: {
  last_incremental_at?: string;
  last_backfill_at?: string;
  last_stats?: Record<string, unknown>;
  last_kkpan_watermark?: number;
}): Promise<void> {
  const db = await getDatabase();
  const collection = db.collection<PanSyncStateDoc>(COLLECTIONS.PAN_SYNC_STATE);
  const now = new Date().toISOString();

  await collection.updateOne(
    { id: 1 },
    { $set: { id: 1, ...patch, updated_at: now } },
    { upsert: true }
  );
}
