import { getDatabase } from "./db";
import { COLLECTIONS } from "./constants/db";
import { ObjectId } from "mongodb";
import type {
  ShortDrama,
  ShortDramaStatus,
  ShortDramaUpsertInput,
  ShortDramaSyncState,
} from "@/types/short-drama";

/**
 * 短剧库（MongoDB short_dramas）
 *
 * 抓取器按 (source, source_article_id) 幂等 upsert；转存流水线更新
 * 状态机与元数据关联；前台按标签/搜索/时间分页读取（只读公开）。
 */

// 数据库文档（蛇形字段，与 collection 一致；ShortDrama 本身就是蛇形）
type ShortDramaDoc = ShortDrama & {
  _id?: ObjectId;
};

function toView(doc: ShortDramaDoc): ShortDrama {
  const { _id, ...rest } = doc;
  return { ...rest, id: _id?.toString() || "" };
}

const MAX_TEXT_LENGTH = 20_000;

function boundedText(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** 抓取入库：按源内文章 ID 幂等 upsert；已存在时只补抓取期可变字段 */
export async function upsertShortDramaFromScrape(
  input: ShortDramaUpsertInput
): Promise<{ drama: ShortDrama; created: boolean }> {
  const db = await getDatabase();
  const collection = db.collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS);
  const now = new Date().toISOString();

  const title = boundedText(input.title);
  if (!title) throw new RangeError("短剧标题不能为空");
  if (!/^\d{1,10}$/.test(input.source_article_id)) {
    throw new RangeError("source_article_id 必须是数字");
  }

  // 重抓刷新字段放 $set（源站可能补标签/换链接）；初始创建字段放 $setOnInsert。
  // 同一路径绝不能同时出现在 $set 与 $setOnInsert（Mongo 报 ConflictingUpdateOperators）。
  const providedTags = (input.tags || [])
    .map((tag) => boundedText(tag, 40))
    .filter(Boolean);
  const result = await collection.findOneAndUpdate(
    {
      source: input.source,
      source_article_id: input.source_article_id,
    },
    {
      $set: {
        updated_at: now,
        ...(providedTags.length > 0 ? { tags: providedTags } : {}),
        ...(input.source_share_url
          ? { source_share_url: boundedText(input.source_share_url, 2000) }
          : {}),
      },
      $setOnInsert: {
        source: input.source,
        source_article_id: input.source_article_id,
        title,
        ...(providedTags.length === 0 ? { tags: [] } : {}),
        ...(input.publish_date
          ? { publish_date: boundedText(input.publish_date, 10) }
          : {}),
        ...(Number.isInteger(input.episode_count)
          ? { episode_count: input.episode_count }
          : {}),
        status: "discovered" as ShortDramaStatus,
        transfer_attempts: 0,
        enabled: true,
        created_at: now,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  const doc = result as ShortDramaDoc | null;
  if (!doc) throw new Error("短剧 upsert 失败");
  return { drama: toView(doc), created: !doc.created_at || doc.created_at === now };
}

export interface ShortDramaListQuery {
  tag?: string;
  search?: string;
  status?: ShortDramaStatus;
  page?: number;
  limit?: number;
  includeDisabled?: boolean;
}

export async function listShortDramas(
  query: ShortDramaListQuery = {}
): Promise<{ dramas: ShortDrama[]; total: number; page: number; limit: number }> {
  const db = await getDatabase();
  const collection = db.collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS);

  const page = Math.max(1, Math.min(query.page || 1, 10_000));
  const limit = Math.max(1, Math.min(query.limit || 24, 100));

  const filter: Record<string, unknown> = {};
  if (!query.includeDisabled) filter.enabled = true;
  if (query.status) filter.status = query.status;
  if (query.tag) filter.tags = boundedText(query.tag, 40);
  if (query.search) {
    const search = boundedText(query.search, 100);
    if (search) filter.title = { $regex: escapeRegex(search), $options: "i" };
  }

  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ updated_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { dramas: docs.map(toView), total, page, limit };
}

export async function getShortDramaById(id: string): Promise<ShortDrama | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDatabase();
  const doc = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .findOne({ _id: new ObjectId(id), enabled: true });
  return doc ? toView(doc) : null;
}

/** 按源 + 源文章 ID 精确查找（抓取续跑判重用） */
export async function getShortDramaBySourceArticleId(
  source: ShortDrama["source"],
  sourceArticleId: string
): Promise<ShortDrama | null> {
  if (!/^\d{1,10}$/.test(sourceArticleId)) return null;
  const db = await getDatabase();
  const doc = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .findOne({ source, source_article_id: sourceArticleId });
  return doc ? toView(doc) : null;
}

/** 给短剧追加标签（已存在则跳过）；命中返回 true */
export async function appendShortDramaTags(
  source: ShortDrama["source"],
  sourceArticleId: string,
  tags: string[]
): Promise<boolean> {
  if (!/^\d{1,10}$/.test(sourceArticleId) || tags.length === 0) return false;
  const db = await getDatabase();
  const result = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .updateOne(
      { source, source_article_id: sourceArticleId },
      {
        $addToSet: { tags: { $each: tags.map((tag) => boundedText(tag, 40)).filter(Boolean) } },
        $set: { updated_at: new Date().toISOString() },
      }
    );
  return result.modifiedCount === 1;
}

/** 转存流水线取下一批待转存短剧（discovered 优先，failed 可重试） */
export async function takeShortDramasForTransfer(
  limit: number,
  maxAttempts: number
): Promise<ShortDrama[]> {
  const db = await getDatabase();
  const docs = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .find({
      enabled: true,
      source_share_url: { $type: "string" },
      $and: [
        { status: { $ne: "done" } },
        { status: { $ne: "invalid" } },
        { status: { $ne: "transferring" } },
        { $or: [{ status: "discovered" }, { transfer_attempts: { $lt: maxAttempts } }] },
      ],
    })
    .sort({ created_at: 1 })
    .limit(Math.min(Math.max(limit, 1), 50))
    .toArray();
  return docs.map(toView);
}

export interface ShortDramaTransferPatch {
  status?: ShortDramaStatus;
  transfer_error?: string;
  clear_transfer_error?: boolean;
  own_share_url?: string;
  own_share_code?: string;
  own_folder_fid?: string;
  cover_url?: string;
  intro?: string;
  metadata?: Record<string, unknown>;
}

/** 转存结果回写（状态机推进） */
export async function patchShortDramaTransfer(
  id: string,
  patch: ShortDramaTransferPatch
): Promise<void> {
  if (!ObjectId.isValid(id)) throw new RangeError("短剧 ID 无效");
  const db = await getDatabase();
  const now = new Date().toISOString();
  const set: Record<string, unknown> = { updated_at: now };
  if (patch.status) set.status = patch.status;
  if (patch.own_share_url) set.own_share_url = boundedText(patch.own_share_url, 2000);
  if (patch.own_share_code) set.own_share_code = boundedText(patch.own_share_code, 32);
  if (patch.own_folder_fid) set.own_folder_fid = boundedText(patch.own_folder_fid, 128);
  if (patch.cover_url) set.cover_url = boundedText(patch.cover_url, 2000);
  if (patch.intro) set.intro = patch.intro.slice(0, MAX_TEXT_LENGTH);
  if (patch.metadata) set.metadata = patch.metadata;
  if (patch.transfer_error) set.transfer_error = patch.transfer_error.slice(0, 2000);
  if (patch.clear_transfer_error) set.transfer_error = null;

  const inc: Record<string, number> = {};
  if (patch.status === "transferring") inc.transfer_attempts = 1;

  await db.collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS).updateOne(
    { _id: new ObjectId(id) },
    inc.transfer_attempts > 0 ? { $set: set, $inc: inc } : { $set: set }
  );
}

/** 标签聚合计数（前台标签云） */
export async function listShortDramaTagCounts(
  limit = 100
): Promise<Array<{ tag: string; count: number }>> {
  const db = await getDatabase();
  const rows = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .aggregate<{ _id: string; count: number }>([
      { $match: { enabled: true } },
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: Math.min(Math.max(limit, 1), 300) },
    ])
    .toArray();
  return rows.map((row) => ({ tag: row._id, count: row.count }));
}

export interface ShortDramaStats {
  total: number;
  by_status: Record<ShortDramaStatus, number>;
}

export async function getShortDramaStats(): Promise<ShortDramaStats> {
  const db = await getDatabase();
  const collection = db.collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS);
  const [total, byStatus] = await Promise.all([
    collection.countDocuments({}),
    collection
      .aggregate<{ _id: ShortDramaStatus; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);
  const by_status: Record<ShortDramaStatus, number> = {
    discovered: 0,
    transferring: 0,
    done: 0,
    failed: 0,
    invalid: 0,
  };
  for (const row of byStatus) {
    if (row._id in by_status) by_status[row._id] = row.count;
  }
  return { total, by_status };
}

// ---------------------------------------------------------------------------
// 同步状态（short_drama_sync_state，单例 id:1）
// ---------------------------------------------------------------------------

const SYNC_STATE_ID = 1;

export async function getShortDramaSyncState(): Promise<ShortDramaSyncState | null> {
  const db = await getDatabase();
  const doc = await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .findOne({ id: SYNC_STATE_ID });
  return doc || null;
}

export async function updateShortDramaSyncState(
  patch: Partial<Omit<ShortDramaSyncState, "id">>
): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: SYNC_STATE_ID },
      { $set: { ...patch, updated_at: now }, $setOnInsert: { id: SYNC_STATE_ID } },
      { upsert: true }
    );
}

/** 任务租约：防并发跑批（内存多实例由 expires_at 兜底） */
export async function tryAcquireShortDramaLease(
  task: "scrape" | "transfer",
  ttlMs: number
): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const collection = db.collection<ShortDramaSyncState>(
    COLLECTIONS.SHORT_DRAMA_SYNC_STATE
  );

  // 过期租约直接清除
  await collection.updateOne(
    { id: SYNC_STATE_ID, "running.expires_at": { $lte: now } },
    { $set: { running: null, updated_at: now } }
  );

  const result = await collection.updateOne(
    { id: SYNC_STATE_ID, running: null },
    {
      $set: {
        running: {
          task,
          started_at: now,
          expires_at: new Date(nowMs + ttlMs).toISOString(),
        },
        updated_at: now,
      },
      $setOnInsert: { id: SYNC_STATE_ID },
    },
    { upsert: true }
  );
  return result.upsertedCount === 1 || result.modifiedCount === 1;
}

export async function releaseShortDramaLease(
  task: "scrape" | "transfer"
): Promise<void> {
  const db = await getDatabase();
  await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: SYNC_STATE_ID, "running.task": task },
      { $set: { running: null, updated_at: new Date().toISOString() } }
    );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 读取持久化的标签归类映射（组名 → 标签[]）；未同步过返回 null */
export async function getShortDramaTagGroups(): Promise<Record<string, string[]> | null> {
  const state = await getShortDramaSyncState();
  const groups = state?.tag_groups;
  if (!groups || typeof groups !== "object") return null;
  const entries = Object.entries(groups).filter(
    ([category, tags]) =>
      typeof category === "string" &&
      category.length > 0 &&
      Array.isArray(tags) &&
      tags.length > 0
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** 持久化标签归类映射（runTagGroupSync 调用，整体覆盖） */
export async function appendShortDramaTagGroups(
  groups: Record<string, string[]>
): Promise<void> {
  const cleaned: Record<string, string[]> = {};
  for (const [category, tags] of Object.entries(groups)) {
    const name = category.trim();
    const list = Array.isArray(tags)
      ? tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [];
    if (name && list.length > 0) cleaned[name] = list;
  }
  if (Object.keys(cleaned).length === 0) return;
  await updateShortDramaSyncState({ tag_groups: cleaned });
}
