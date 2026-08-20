import { getDatabase } from "./db";
import { COLLECTIONS } from "./constants/db";
import { ObjectId, type Filter } from "mongodb";
import {
  PAN_BRANDS,
  type PanBrand,
  type PanResource,
  type PanResourceInput,
} from "@/types/pan-resource";
import { resolveContentIdentity } from "@/lib/content-identity-db";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";

const CONTENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;

function validateProviderRef(providerId?: string, providerResourceId?: string): void {
  if (Boolean(providerId) !== Boolean(providerResourceId)) {
    throw new RangeError("provider_id 和 provider_resource_id 必须同时提供");
  }
  if (!providerId) return;
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new RangeError("provider_id 格式无效");
  }
  if (
    !providerResourceId ||
    providerResourceId.length > 500 ||
    /[\u0000-\u001f]/.test(providerResourceId)
  ) {
    throw new RangeError("provider_resource_id 格式无效");
  }
}

// 数据库文档类型（蛇形字段，与 collection 存储一致）
export interface PanResourceDoc {
  _id?: ObjectId;
  douban_id: string;
  content_id?: string;
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
  provider_id?: string;
  provider_resource_id?: string;
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
  // 增量同步水位：已完整扫描目录后，稳定快照中的最大 updated_at。
  // 同一时间戳的全部 ID 单独保存，避免并列时间戳在分页/limit 边界被跳过。
  last_kkpan_watermark?: string;
  // 高水位时刻稳定快照中的全部 ID；同时间戳后到的新 ID 仍会被识别。
  last_kkpan_watermark_ids?: number[];
  // 已进入稳定快照但受本轮豆瓣请求预算限制、尚未处理的 kkpan ID。
  last_kkpan_pending_ids?: number[];
  // 失效检测按片名轮转时的最后一个片名，避免固定只检查资源最多的前 N 组。
  last_availability_cursor?: string;
  sync_lease?: {
    owner: string;
    expires_at: string;
  };
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
    content_id: doc.content_id,
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
    provider_id: doc.provider_id,
    provider_resource_id: doc.provider_resource_id,
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

  return sortPanResources(docs.map(docToPanResource));
}

/** Preferred host-identity read path. Douban ID remains a compatibility fallback. */
export async function getPanResourcesByContentId(
  contentId: string
): Promise<PanResource[]> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const docs = await collection
    .find({ content_id: contentId, enabled: true })
    .sort({ updated_at: -1 })
    .toArray();
  return sortPanResources(docs.map(docToPanResource));
}

function sortPanResources(resources: PanResource[]): PanResource[] {
  return resources.sort((a, b) => {
    const diff =
      (BRAND_ORDER[a.brand] ?? BRAND_ORDER.length) -
      (BRAND_ORDER[b.brand] ?? BRAND_ORDER.length);
    if (diff !== 0) return diff;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

/** Read one resource for admin mutations and migration-aware validation. */
export async function getPanResourceById(id: string): Promise<PanResource | null> {
  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    return null;
  }
  const db = await getDatabase();
  const doc = await db
    .collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES)
    .findOne({ _id: objectId });
  return doc ? docToPanResource(doc) : null;
}

export async function countPanResourcesByDoubanId(
  doubanId: string
): Promise<number> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  return collection.countDocuments({ douban_id: doubanId });
}

export async function countEnabledPanResourcesByDoubanId(
  doubanId: string
): Promise<number> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  return collection.countDocuments({ douban_id: doubanId, enabled: true });
}

// 查询参数
export interface PanResourceQueryOptions {
  doubanId?: string;
  contentId?: string;
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
  if (options.contentId) {
    filter.content_id = options.contentId;
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

/**
 * 返回历史上已经录入过网盘资源的影片，供影片级同步台账补齐“已收录但
 * 当前不在首页/分类快照”的条目。只使用保存时的 movie_title，不把资源
 * 文件名误当成影片名。
 */
export async function getKnownPanMovieTargets(): Promise<
  Array<{ douban_id: string; title: string }>
> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const docs = await collection
    .find(
      { movie_title: { $type: "string" } } as unknown as Filter<PanResourceDoc>,
      { projection: { douban_id: 1, movie_title: 1 } }
    )
    .toArray();
  const targets = new Map<string, string>();
  for (const doc of docs) {
    const doubanId = String(doc.douban_id || "").trim();
    const title = String(doc.movie_title || "").trim();
    if (/^\d{1,20}$/.test(doubanId) && title && !targets.has(doubanId)) {
      targets.set(doubanId, title.slice(0, 200));
    }
  }
  return [...targets].map(([douban_id, title]) => ({ douban_id, title }));
}

// 新增网盘资源。
// 幂等保证：当 input.source === "kkpan" 且带数字 kkpan_id 时，依赖 pan_resources
// 上 kkpan_id 的部分唯一索引（partialFilterExpression: { kkpan_id: { $type:"number" } }）
// 保证同 kkpan_id 全局只有一条。并发同步撞到同一 kkpan_id 时，后到的一次 insertOne
// 会抛 duplicate key（错误码 11000），本函数捕获后回退为按 kkpan_id 查出现有文档返回，
// 调用方通过 created=false 区分。
//
// 重要：手工录入（kkpan_id 为 undefined / null）时，**文档不写入 kkpan_id 字段**，
// 而不是写入 null。因为 MongoDB 驱动默认会把 undefined 序列化为 null，而部分唯一索引
// 即使加 $type 过滤也无法规避同一集合多条 null 文档的语义混乱——直接省略字段最干净。
export async function createPanResourceInDB(
  input: Required<Pick<PanResourceInput, "douban_id" | "brand" | "title" | "url">> &
    PanResourceInput
): Promise<{ resource: PanResource; created: boolean }> {
  if (
    typeof input.douban_id !== "string" ||
    !/^\d{1,20}$/.test(input.douban_id)
  ) {
    throw new RangeError("douban_id 格式无效");
  }
  const now = new Date().toISOString();
  const hasKkpanId =
    typeof input.kkpan_id === "number" &&
    Number.isSafeInteger(input.kkpan_id) &&
    input.kkpan_id > 0;
  const providerId = input.provider_id?.trim();
  const providerResourceId = input.provider_resource_id?.trim();
  const hasProviderRef = Boolean(providerId && providerResourceId);
  validateProviderRef(providerId, providerResourceId);
  if (input.kkpan_id !== undefined && !hasKkpanId) {
    throw new RangeError("kkpan_id 必须是正安全整数");
  }
  if (input.content_id !== undefined && !CONTENT_ID_PATTERN.test(input.content_id)) {
    throw new RangeError("content_id 必须是有效 UUID");
  }
  if (input.source === "kkpan" && !hasKkpanId) {
    throw new RangeError("kkpan 来源资源必须提供有效 kkpan_id");
  }

  const identity = await resolveContentIdentity([
    { providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: input.douban_id },
  ]);
  if (input.content_id && input.content_id !== identity.contentId) {
    throw new RangeError("content_id 与 douban_id 的宿主身份不一致");
  }

  // 手工录入时省略 kkpan_id 字段，避免 undefined→null 触发唯一索引语义歧义
  const doc: Omit<PanResourceDoc, "_id"> = {
    douban_id: input.douban_id,
    content_id: identity.contentId,
    internal_id: input.internal_id,
    movie_title: input.movie_title,
    brand: input.brand,
    title: input.title,
    size: input.size,
    format: input.format,
    url: input.url,
    code: input.code,
    note: input.note,
    // 带 kkpan_id 的资源始终归为 kkpan 来源，避免调用方误传 manual 后绕过失效联动。
    source: hasKkpanId ? "kkpan" : input.source,
    ...(hasProviderRef
      ? { provider_id: providerId, provider_resource_id: providerResourceId }
      : {}),
    enabled: input.enabled ?? true,
    created_at: now,
    updated_at: now,
    ...(hasKkpanId
      ? { kkpan_id: input.kkpan_id }
      : {}),
  };
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  try {
    const result = await collection.insertOne(doc);
    return {
      resource: docToPanResource({ ...doc, _id: result.insertedId }),
      created: true,
    };
  } catch (err) {
    // 对兼容 kkpan_id 或统一 provider 引用做 duplicate key 幂等兜底。
    const code = (err as { code?: number; codeName?: string })?.code;
    const isDuplicate =
      code === 11000 ||
      (err as Error)?.message?.toLowerCase?.().includes("duplicate key");
    if (!((hasKkpanId || hasProviderRef) && isDuplicate)) {
      throw err;
    }
    const [kkpanExisting, providerExisting] = await Promise.all([
      hasKkpanId
        ? collection.findOne({ kkpan_id: input.kkpan_id })
        : Promise.resolve(null),
      hasProviderRef
        ? collection.findOne({
            provider_id: providerId,
            provider_resource_id: providerResourceId,
          })
        : Promise.resolve(null),
    ]);
    if (
      kkpanExisting &&
      providerExisting &&
      String(kkpanExisting._id) !== String(providerExisting._id)
    ) {
      throw new Error("kkpan_id 与 provider 引用分别关联到不同资源，需要人工处理");
    }
    const existing = kkpanExisting || providerExisting;
    if (!existing) throw err; // 不应该走到，保守重抛
    if (existing.douban_id !== input.douban_id) {
      throw new Error("同一 kkpan_id 已关联到其他影片，需要人工处理");
    }
    if (
      input.content_id &&
      existing.content_id &&
      existing.content_id !== input.content_id
    ) {
      throw new Error("同一 kkpan_id 已关联到其他 content_id，需要人工处理");
    }
    if (
      hasProviderRef &&
      existing.provider_id &&
      (existing.provider_id !== providerId ||
        existing.provider_resource_id !== providerResourceId)
    ) {
      throw new Error("同一资源已经关联到其他 provider 引用，需要人工处理");
    }
    const compatibilityBackfill: Partial<PanResourceDoc> = {};
    if (input.content_id && !existing.content_id) {
      compatibilityBackfill.content_id = input.content_id;
    }
    if (hasProviderRef && !existing.provider_id) {
      compatibilityBackfill.provider_id = providerId;
      compatibilityBackfill.provider_resource_id = providerResourceId;
    }
    if (Object.keys(compatibilityBackfill).length > 0) {
      const updated = await collection.findOneAndUpdate(
        { _id: existing._id },
        { $set: { ...compatibilityBackfill, updated_at: now } },
        { returnDocument: "after" }
      );
      if (updated) return { resource: docToPanResource(updated), created: false };
    }
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
  const unsetDoc: Record<string, ""> = {};
  if (updates.douban_id !== undefined) setDoc.douban_id = updates.douban_id;
  if (updates.content_id !== undefined) {
    if (!CONTENT_ID_PATTERN.test(updates.content_id)) {
      throw new RangeError("content_id 必须是有效 UUID");
    }
    setDoc.content_id = updates.content_id;
  }
  if (updates.internal_id !== undefined)
    setDoc.internal_id = updates.internal_id;
  if (updates.movie_title !== undefined)
    setDoc.movie_title = updates.movie_title;
  if (updates.brand !== undefined) setDoc.brand = updates.brand;
  if (updates.title !== undefined) setDoc.title = updates.title;
  if (updates.size !== undefined) setDoc.size = updates.size;
  if (updates.format !== undefined) setDoc.format = updates.format;
  if (updates.url !== undefined) setDoc.url = updates.url;
  if (updates.clear_code) unsetDoc.code = "";
  else if (updates.code !== undefined) setDoc.code = updates.code;
  if (updates.note !== undefined) setDoc.note = updates.note;
  if (updates.source !== undefined) setDoc.source = updates.source;
  if (
    updates.provider_id !== undefined ||
    updates.provider_resource_id !== undefined
  ) {
    const providerId = updates.provider_id?.trim();
    const providerResourceId = updates.provider_resource_id?.trim();
    validateProviderRef(providerId, providerResourceId);
    setDoc.provider_id = providerId;
    setDoc.provider_resource_id = providerResourceId;
  }
  if (updates.kkpan_id !== undefined) {
    if (!Number.isSafeInteger(updates.kkpan_id) || updates.kkpan_id <= 0) {
      throw new RangeError("kkpan_id 必须是正安全整数");
    }
    setDoc.kkpan_id = updates.kkpan_id;
    // 只要写入 kkpan_id，就必须保持来源为 kkpan，避免更新请求把已关联
    // 的资源标成 manual 后脱离失效联动。
    setDoc.source = "kkpan";
  }
  if (updates.enabled !== undefined) setDoc.enabled = updates.enabled;

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    return null;
  }

  const existingDoc = await collection.findOne({ _id: objectId });
  if (!existingDoc) return null;
  const targetDoubanId = updates.douban_id ?? existingDoc.douban_id;
  if (
    typeof targetDoubanId !== "string" ||
    !/^\d{1,20}$/.test(targetDoubanId)
  ) {
    throw new RangeError("douban_id 格式无效");
  }
  const identity = await resolveContentIdentity([
    { providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: targetDoubanId },
  ]);
  if (updates.content_id !== undefined && updates.content_id !== identity.contentId) {
    throw new RangeError("content_id 与 douban_id 的宿主身份不一致");
  }
  setDoc.content_id = identity.contentId;

  const update: {
    $set: Partial<PanResourceDoc>;
    $unset?: Record<string, "">;
  } = { $set: setDoc };
  if (Object.keys(unsetDoc).length > 0) update.$unset = unsetDoc;

  try {
    const result = await collection.findOneAndUpdate({ _id: objectId }, update, {
      returnDocument: "after",
    });
    return result ? docToPanResource(result) : null;
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code !== 11000) throw error;
    throw new Error("来源资源身份已被其他资源占用，需要人工处理");
  }
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

export async function getExistingPanKeysForCandidates(input: {
  urls: string[];
  kkpanIds: number[];
}): Promise<{ urls: Set<string>; kkpanIds: Set<number> }> {
  const urls = [...new Set(input.urls.filter(Boolean))];
  const kkpanIds = [
    ...new Set(
      input.kkpanIds.filter(
        (value) => Number.isSafeInteger(value) && value > 0
      )
    ),
  ];
  if (urls.length === 0 && kkpanIds.length === 0) {
    return { urls: new Set(), kkpanIds: new Set() };
  }

  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const clauses: Filter<PanResourceDoc>[] = [];
  if (urls.length > 0) clauses.push({ url: { $in: urls } });
  if (kkpanIds.length > 0) {
    clauses.push({ kkpan_id: { $in: kkpanIds } });
  }
  const docs = await collection
    .find({ $or: clauses } as Filter<PanResourceDoc>, {
      projection: { url: 1, kkpan_id: 1 },
    })
    .toArray();
  return {
    urls: new Set(docs.map((doc) => doc.url).filter(Boolean)),
    kkpanIds: new Set(
      docs
        .map((doc) => doc.kkpan_id)
        .filter((value): value is number => typeof value === "number")
    ),
  };
}

// kkpan 来源的资源（失效联动检测用），按更新时间倒序
export async function getKkpanSourceResources(limit?: number): Promise<PanResource[]> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  const cursor = collection
    .find({ source: "kkpan" as const })
    .sort({ updated_at: -1 });
  if (limit != null && limit > 0) cursor.limit(limit);
  const docs = await cursor.toArray();

  return docs.map(docToPanResource);
}

export async function getKkpanSourceResourcesByDoubanId(
  doubanId: string
): Promise<PanResource[]> {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const docs = await collection
    .find({ source: "kkpan" as const, douban_id: doubanId })
    .sort({ updated_at: -1 })
    .toArray();
  return docs.map(docToPanResource);
}

// ==================== 同步状态 ====================

const PAN_SYNC_LEASE_TTL_MS = 5 * 60 * 1000;

function leaseExpiry(ttlMs = PAN_SYNC_LEASE_TTL_MS): string {
  const bounded = Math.min(Math.max(ttlMs, 60_000), 30 * 60 * 1000);
  return new Date(Date.now() + bounded).toISOString();
}

// 用 pan_sync_state 单例文档做跨进程租约；唯一 kkpan_id 索引只能防重复 insert，
// 不能保护失效禁用和同步游标的 last-writer-wins。
export async function acquirePanSyncLease(
  owner: string,
  ttlMs = PAN_SYNC_LEASE_TTL_MS
): Promise<boolean> {
  const db = await getDatabase();
  const collection = db.collection<PanSyncStateDoc>(COLLECTIONS.PAN_SYNC_STATE);
  const now = new Date().toISOString();

  try {
    await collection.updateOne(
      { id: 1 },
      { $setOnInsert: { id: 1, updated_at: now } },
      { upsert: true }
    );
  } catch (error) {
    // 两个进程首次抢租时都可能尝试 upsert 单例文档；唯一 id 索引让其中
    // 一个收到 duplicate-key，这是正常竞态，继续执行原子 lease 更新即可。
    const code = (error as { code?: number })?.code;
    if (code !== 11000) throw error;
  }
  const result = await collection.findOneAndUpdate(
    {
      id: 1,
      $or: [
        { sync_lease: { $exists: false } },
        { "sync_lease.expires_at": { $lte: now } },
        { "sync_lease.owner": owner },
      ],
    },
    {
      $set: {
        sync_lease: { owner, expires_at: leaseExpiry(ttlMs) },
        updated_at: now,
      },
    },
    { returnDocument: "after" }
  );
  return result?.sync_lease?.owner === owner;
}

export async function renewPanSyncLease(
  owner: string,
  ttlMs = PAN_SYNC_LEASE_TTL_MS
): Promise<boolean> {
  const db = await getDatabase();
  const collection = db.collection<PanSyncStateDoc>(COLLECTIONS.PAN_SYNC_STATE);
  const result = await collection.updateOne(
    { id: 1, "sync_lease.owner": owner },
    {
      $set: {
        "sync_lease.expires_at": leaseExpiry(ttlMs),
        updated_at: new Date().toISOString(),
      },
    }
  );
  return result.modifiedCount === 1;
}

export async function releasePanSyncLease(owner: string): Promise<void> {
  const db = await getDatabase();
  const collection = db.collection<PanSyncStateDoc>(COLLECTIONS.PAN_SYNC_STATE);
  await collection.updateOne(
    { id: 1, "sync_lease.owner": owner },
    {
      $unset: { sync_lease: "" },
      $set: { updated_at: new Date().toISOString() },
    }
  );
}

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
  last_kkpan_watermark?: string;
  last_kkpan_watermark_ids?: number[];
  last_kkpan_pending_ids?: number[];
  last_availability_cursor?: string;
}): Promise<void> {
  const db = await getDatabase();
  const collection = db.collection<PanSyncStateDoc>(COLLECTIONS.PAN_SYNC_STATE);
  const now = new Date().toISOString();

  const setDoc: Record<string, unknown> = { id: 1, updated_at: now };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) setDoc[key] = value;
  }

  await collection.updateOne({ id: 1 }, { $set: setDoc }, { upsert: true });
}
