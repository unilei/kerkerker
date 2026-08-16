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
  note?: string;
  enabled: boolean;
  created_at: string; // ISO 字符串格式
  updated_at: string; // ISO 字符串格式
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
    note: doc.note,
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

// 新增网盘资源
export async function createPanResourceInDB(
  input: Required<Pick<PanResourceInput, "douban_id" | "brand" | "title" | "url">> &
    PanResourceInput
): Promise<PanResource> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const now = new Date().toISOString();

  const doc: PanResourceDoc = {
    douban_id: input.douban_id,
    internal_id: input.internal_id,
    movie_title: input.movie_title,
    brand: input.brand,
    title: input.title,
    size: input.size,
    format: input.format,
    url: input.url,
    note: input.note,
    enabled: input.enabled ?? true,
    created_at: now,
    updated_at: now,
  };

  const result = await collection.insertOne(doc);
  return docToPanResource({ ...doc, _id: result.insertedId });
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
  if (updates.note !== undefined) setDoc.note = updates.note;
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
