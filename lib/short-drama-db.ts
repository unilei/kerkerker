import { getDatabase } from "./db";
import { COLLECTIONS } from "./constants/db";
import { ObjectId } from "mongodb";
import type { Filter } from "mongodb";
import { shortDramaKeysetFilter, type ListCursor } from "./list-cursor";
import {
  bumpShortDramaCache,
  cachedRead,
  SHORT_DRAMA_CACHE_PREFIX,
  SHORT_DRAMA_CACHE_TTL_MS,
  SHORT_DRAMA_SITEMAP_CACHE_TTL_MS,
} from "./cache";
import type {
  ShortDrama,
  ShortDramaMetadataPiece,
  ShortDramaStatus,
  ShortDramaUpsertInput,
  ShortDramaSyncState,
  ShortDramaTaskLease,
} from "@/types/short-drama";

/**
 * 短剧库（MongoDB short_dramas）
 *
 * 条目同步按 (source, content_key) 幂等 upsert（content_key 是归一化
 * 剧名键，跨 kkpan 行变化稳定）；元数据同步回填三件套并维护
 * missing_at_source 终结标记；前台按标签/搜索/时间分页读取（只读公开，
 * 走进程内 TTL 缓存，由写函数 bumpShortDramaCache() 即时失效）。
 */

const sdCacheKey = (suffix: string) => `${SHORT_DRAMA_CACHE_PREFIX}${suffix}`;

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

/**
 * 条目同步批量入库：按 (source, content_key) 幂等 upsert。
 * 可变字段放 $set（kkpan 侧标题/链接/集数/日期变化即回写）；首建字段放
 * $setOnInsert——description 兜底简介只写一次，避免覆盖元数据同步采集的
 * 简介.txt。返回新建/更新计数与新建文档的 id（供搜索引擎推送）。
 */
export async function upsertShortDramasFromKkpan(
  inputs: ShortDramaUpsertInput[]
): Promise<{ created: number; updated: number; createdIds: string[] }> {
  if (inputs.length === 0) return { created: 0, updated: 0, createdIds: [] };
  const db = await getDatabase();
  const collection = db.collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS);
  const now = new Date().toISOString();

  const ops = inputs.map((input) => {
    const shareUrl = boundedText(input.share_url, 2000);
    if (!input.title) throw new RangeError("短剧标题不能为空");
    if (!input.content_key) throw new RangeError("content_key 不能为空");
    if (!shareUrl) throw new RangeError("share_url 不能为空");
    return {
      updateOne: {
        filter: { source: input.source, content_key: input.content_key },
        update: {
          $set: {
            updated_at: now,
            source_article_id: input.source_article_id,
            title: input.title,
            ...(Number.isInteger(input.episode_count)
              ? { episode_count: input.episode_count }
              : {}),
            share_url: shareUrl,
            ...(input.share_code ? { share_code: boundedText(input.share_code, 32) } : {}),
            ...(input.publish_date
              ? { publish_date: boundedText(input.publish_date, 10) }
              : {}),
            status: "published" as ShortDramaStatus,
          },
          $setOnInsert: {
            tags: [] as string[],
            ...(input.description ? { intro: input.description.slice(0, MAX_TEXT_LENGTH) } : {}),
            created_at: now,
          },
        },
        upsert: true,
      },
    };
  });

  // bulkWrite 单批上限 100k ops，按 500 一批控制内存与失败重放粒度；
  // upsertedIds 的键是批内 op 下标，映射回全局 inputs 下标取新建文档 id
  const createdIds: string[] = [];
  for (let i = 0; i < ops.length; i += 500) {
    const result = await collection.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    for (const [opIndex, insertedId] of Object.entries(result.upsertedIds)) {
      const input = inputs[i + Number(opIndex)];
      if (input) createdIds.push(insertedId.toString());
    }
  }
  bumpShortDramaCache();
  return { created: createdIds.length, updated: inputs.length - createdIds.length, createdIds };
}

/** 全量同步收尾：content_key 不在 kkpan 当前集合里的条目置 offline（复活语义：
 *  条目重新出现在 kkpan 时下轮全量同步会自动置回 published） */
export async function markShortDramasOfflineNotInContentKeys(
  contentKeys: Set<string>
): Promise<number> {
  const db = await getDatabase();
  const result = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .updateMany(
      {
        source: "kkpan" as ShortDrama["source"],
        status: "published" as ShortDramaStatus,
        content_key: { $nin: Array.from(contentKeys) },
      },
      { $set: { status: "offline", updated_at: new Date().toISOString() } }
    );
  if (result.modifiedCount > 0) bumpShortDramaCache();
  return result.modifiedCount;
}

export interface ShortDramaListQuery {
  tag?: string;
  search?: string;
  status?: ShortDramaStatus;
  /** 后台账账等管理视图：不做 published 默认过滤（可再叠加 status 精筛） */
  includeOffline?: boolean;
  /** 只列已有分享链接的（/all 分页页与 sitemap 同口径，保证总页数一致） */
  hasShareUrl?: boolean;
  page?: number;
  limit?: number;
  /**
   * 覆写默认 100 的 limit 钳制：仅供后台批量取数用；公开接口保持 100
   * 上限，防止外部一次拉走大半张表
   */
  limitMax?: number;
  /**
   * keyset 游标（首页「加载更多」）：取该锚点之后的条目，page 被忽略、
   * skip=0。游标翻页不受后台写入造成的排序漂移影响。
   */
  after?: ListCursor;
}

export async function listShortDramas(
  query: ShortDramaListQuery = {}
): Promise<{ dramas: ShortDrama[]; total: number; page: number; limit: number }> {
  const db = await getDatabase();
  const collection = db.collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS);

  const page = Math.max(1, Math.min(query.page || 1, 10_000));
  const limit = Math.max(1, Math.min(query.limit || 24, query.limitMax ?? 100));

  const filter = baseFilterOf(query);
  // keyset 游标：以上一页末条为锚点取其后内容，翻页期间数据漂移不再
  // 造成跨页重复/漏项（offset 分页的固有缺陷）。与 page 互斥，游标优先。
  if (query.after) filter.$and = [shortDramaKeysetFilter(query.after)];

  const [docs, total] = await Promise.all([
    collection
      .find(filter)
      // 前台排序（全序）：最近更新在前；无日期的退回 created_at（条目同步
      // 首见顺序）；_id 兜底保证同键文档顺序稳定，是 keyset 分页不重不漏
      // 的前提
      .sort({
        publish_date: -1,
        created_at: -1,
        _id: -1,
      })
      .skip(query.after ? 0 : (page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(baseFilterOf(query)),
  ]);

  return { dramas: docs.map(toView), total, page, limit };
}

/** countDocuments 用：剔除 keyset 条件，游标翻页时总数与跳页口径一致 */
function baseFilterOf(query: ShortDramaListQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.includeOffline) {
    if (query.status) filter.status = query.status;
  } else {
    filter.status = query.status ?? ("published" as ShortDramaStatus);
  }
  if (query.tag) filter.tags = boundedText(query.tag, 40);
  if (query.hasShareUrl) filter.share_url = { $type: "string" };
  if (query.search) {
    const search = boundedText(query.search, 100);
    if (search) filter.title = { $regex: escapeRegex(search), $options: "i" };
  }
  return filter;
}

/** Sitemap 用：可公开访问（published 且已有分享链接）的短剧，只投影 id 与时间字段 */
export async function listShortDramaSitemapEntries(
  limit = 50_000
): Promise<{ id: string; updated_at?: string; publish_date?: string }[]> {
  return cachedRead(
    sdCacheKey(`sitemap-entries:${limit}`),
    SHORT_DRAMA_SITEMAP_CACHE_TTL_MS,
    async () => {
      const db = await getDatabase();
      const docs = await db
        .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
        .find(
          {
            status: "published" as ShortDramaStatus,
            share_url: { $type: "string" },
          },
          { projection: { _id: 1, updated_at: 1, publish_date: 1 } }
        )
        .limit(Math.min(Math.max(limit, 1), 50_000))
        .toArray();
      return docs.map((doc) => ({
        id: doc._id?.toString() || "",
        updated_at: doc.updated_at,
        publish_date: doc.publish_date,
      }));
    }
  );
}

export async function getShortDramaById(id: string): Promise<ShortDrama | null> {
  if (!ObjectId.isValid(id)) return null;
  return cachedRead(
    sdCacheKey(`drama:${id}`),
    SHORT_DRAMA_CACHE_TTL_MS,
    async () => {
      const db = await getDatabase();
      const doc = await db
        .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
        .findOne({ _id: new ObjectId(id), status: "published" as ShortDramaStatus });
      return doc ? toView(doc) : null;
    }
  );
}

/** 按后台勾选的 id 精确取短剧（管理操作用；含 offline） */
export async function getShortDramasByIds(ids: string[]): Promise<ShortDrama[]> {
  const objectIds = ids
    .filter((id) => typeof id === "string" && ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id))
    .map((id) => new ObjectId(id));
  if (objectIds.length === 0) return [];
  const db = await getDatabase();
  const docs = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .find({ _id: { $in: objectIds } })
    // 管理操作按最近更新新→旧执行
    .sort({ updated_at: -1 })
    .limit(200)
    .toArray();
  return docs.map(toView);
}

/** 删除本地短剧记录（纯本地操作，不涉及网盘）；返回实际删除的文档 */
export async function deleteShortDramasByIds(
  ids: string[]
): Promise<{ deleted: ShortDrama[]; invalidIds: string[] }> {
  const validIds: string[] = [];
  const invalidIds: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id)) {
      validIds.push(id);
    } else {
      invalidIds.push(id);
    }
  }
  if (validIds.length === 0) return { deleted: [], invalidIds };

  const objectIds = validIds.map((id) => new ObjectId(id));
  const db = await getDatabase();
  const collection = db.collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS);
  const docs = await collection
    .find({ _id: { $in: objectIds } })
    .toArray();
  const result = await collection.deleteMany({ _id: { $in: objectIds } });
  if (result.deletedCount !== docs.length) {
    throw new Error(
      `删除数量不一致：期望 ${docs.length}，实际 ${result.deletedCount}`
    );
  }
  bumpShortDramaCache();
  return { deleted: docs.map(toView), invalidIds };
}

/** 清空短剧库（purge-legacy 一次性动作；sync_state 不动，tag_groups 保留） */
export async function purgeAllShortDramas(): Promise<number> {
  const db = await getDatabase();
  const result = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .deleteMany({});
  bumpShortDramaCache();
  return result.deletedCount;
}

/**
 * 元数据同步队列过滤器（纯函数，供单测）：
 * published 且有分享链接，任一三件套「值缺失（字段不存在或为 null）
 * 且未被 missing_at_source 豁免」。{ field: null } 同时匹配字段缺失与
 * 显式 null；{ metadata_missing…: { $ne } } 对数组字段=「不含该元素」，
 * 对缺省字段恒真。
 */
const METADATA_PIECE_FIELDS: ReadonlyArray<readonly [ShortDramaMetadataPiece, string]> = [
  ["cover", "cover_url"],
  ["intro", "intro"],
  ["metadata", "metadata"],
];

export function shortDramaMetadataSyncFilter(): Record<string, unknown> {
  return {
    status: "published" as ShortDramaStatus,
    share_url: { $type: "string" },
    $or: METADATA_PIECE_FIELDS.map(([piece, field]) => ({
      $and: [
        { $or: [{ [field]: { $exists: false } }, { [field]: null }] },
        { missing_at_source: { $ne: piece } },
      ],
    })),
  };
}

/**
 * 元数据同步取队列：已发布但缺三件套（且未被源缺失标记豁免）的条目，
 * 与前台同序（最近更新新→旧）——先补首屏可见的，补完立刻能在首页看到。
 * limit 上限放宽到 5 万：后台全量补齐要一次取完整个队列。
 */
export async function takeShortDramasForMetadataSync(
  limit: number
): Promise<ShortDrama[]> {
  const db = await getDatabase();
  const docs = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .find(shortDramaMetadataSyncFilter() as Filter<ShortDramaDoc>)
    .sort({ publish_date: -1, created_at: -1, updated_at: -1 })
    .limit(Math.min(Math.max(limit, 1), 50_000))
    .toArray();
  return docs.map(toView);
}

export interface ShortDramaMetadataPatch {
  cover_url?: string;
  intro?: string;
  metadata?: Record<string, unknown>;
  /** 把这些部件标记为「kkpan 转存目录里确认不存在」（同步队列随后豁免） */
  missing_at_source?: ShortDramaMetadataPiece[];
}

/** 元数据同步结果回写 */
export async function patchShortDramaMetadata(
  id: string,
  patch: ShortDramaMetadataPatch
): Promise<void> {
  if (!ObjectId.isValid(id)) throw new RangeError("短剧 ID 无效");
  const db = await getDatabase();
  const now = new Date().toISOString();
  const set: Record<string, unknown> = { updated_at: now };
  if (patch.cover_url) set.cover_url = boundedText(patch.cover_url, 2000);
  if (patch.intro) set.intro = patch.intro.slice(0, MAX_TEXT_LENGTH);
  if (patch.metadata) set.metadata = patch.metadata;
  if (patch.missing_at_source) {
    // 整组覆盖：每次以本轮列目录的核实结果为准（部件找到即移出标记）
    const pieces = patch.missing_at_source.filter((piece) =>
      (["cover", "intro", "metadata"] as const).includes(piece)
    );
    set.missing_at_source = pieces;
  }

  await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .updateOne({ _id: new ObjectId(id) }, { $set: set });
  bumpShortDramaCache();
}

/** 标签聚合计数（前台标签云，published 口径） */
export async function listShortDramaTagCounts(
  limit = 100
): Promise<Array<{ tag: string; count: number }>> {
  const db = await getDatabase();
  const rows = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .aggregate<{ _id: string; count: number }>([
      { $match: { status: "published" as ShortDramaStatus } },
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: Math.min(Math.max(limit, 1), 300) },
    ])
    .toArray();
  return rows.map((row) => ({ tag: row._id, count: row.count }));
}

/**
 * 标签聚合计数——公开口径（published 且已有分享链接，与详情页可达性
 * 一致），带进程内缓存。标签落地页/目录/sitemap 都以这里的数据为准。
 */
export async function listPublicShortDramaTagCounts(
  limit = 200
): Promise<Array<{ tag: string; count: number }>> {
  return cachedRead(
    sdCacheKey(`tag-counts:${limit}`),
    SHORT_DRAMA_CACHE_TTL_MS,
    async () => {
      const db = await getDatabase();
      const rows = await db
        .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
        .aggregate<{ _id: string; count: number }>([
          {
            $match: {
              status: "published" as ShortDramaStatus,
              share_url: { $type: "string" },
            },
          },
          { $unwind: "$tags" },
          { $group: { _id: "$tags", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: Math.min(Math.max(limit, 1), 300) },
        ])
        .toArray();
      return rows.map((row) => ({ tag: row._id, count: row.count }));
    }
  );
}

/** 详情页「相关短剧」：与任一标签有交集的公开短剧（不含自身），最新的在前 */
export async function listRelatedShortDramas(
  id: string,
  tags: string[],
  limit = 8
): Promise<ShortDrama[]> {
  if (!ObjectId.isValid(id) || tags.length === 0) return [];
  const normalizedTags = tags.map((tag) => boundedText(tag, 40)).filter(Boolean);
  return cachedRead(
    sdCacheKey(`related:${id}:${normalizedTags.join("|")}:${limit}`),
    SHORT_DRAMA_CACHE_TTL_MS,
    async () => {
      const db = await getDatabase();
      const docs = await db
        .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
        .find({
          _id: { $ne: new ObjectId(id) },
          status: "published" as ShortDramaStatus,
          share_url: { $type: "string" },
          tags: { $in: normalizedTags },
        })
        .sort({ publish_date: -1, created_at: -1 })
        .limit(Math.min(Math.max(limit, 1), 20))
        .toArray();
      return docs.map(toView);
    }
  );
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
    published: 0,
    offline: 0,
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

/** 清库后复位同步进度（水位/统计清零；tag_groups 与租约结构保留） */
export async function resetShortDramaSyncProgress(): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  // 复位是把字段置 null（sync_state 文档的字段允许 null），不能用泛型
  // ShortDramaSyncState 约束（其可选字段类型不含 null）
  await db
    .collection(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: 1 },
      {
        $set: {
          last_entries_sync_at: null,
          last_entries_sync_stats: null,
          last_metadata_sync_at: null,
          last_metadata_sync_stats: null,
          updated_at: now,
        },
        $setOnInsert: { id: 1 },
      },
      { upsert: true }
    );
}

// ---------------------------------------------------------------------------
// 元数据同步任务租约（单槽 running_sync，防长任务并发跑批；内存多实例
// 由 expires_at 兜底）。条目同步是快速同步请求，不使用租约。
// ---------------------------------------------------------------------------

const SYNC_LEASE_SLOT = "running_sync" as const;
const SYNC_LEASE_TASK = "metadata-sync" as const;

export async function tryAcquireShortDramaSyncLease(ttlMs: number): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const collection = db.collection<ShortDramaSyncState>(
    COLLECTIONS.SHORT_DRAMA_SYNC_STATE
  );

  // 过期租约直接清除；旧版双槽（running_scrape/running_transfer）与更旧
  // 的单槽 running 一并清掉（迁移）
  await collection.updateOne(
    { id: SYNC_STATE_ID, [`${SYNC_LEASE_SLOT}.expires_at`]: { $lte: now } },
    {
      $set: {
        [SYNC_LEASE_SLOT]: null,
        running: null,
        running_scrape: null,
        running_transfer: null,
        updated_at: now,
      },
    }
  );
  await collection.updateOne(
    { id: SYNC_STATE_ID, running: { $ne: null } },
    { $set: { running: null, updated_at: now } }
  );

  try {
    const result = await collection.updateOne(
      { id: SYNC_STATE_ID, [SYNC_LEASE_SLOT]: null },
      {
        $set: {
          [SYNC_LEASE_SLOT]: {
            task: SYNC_LEASE_TASK,
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
  } catch (error) {
    // 租约被未过期任务持有时 filter 不命中，upsert 会撞 id 唯一索引：
    // 这里的语义等价于「已有任务在运行」，不能向上抛 500
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: number }).code === 11000
    ) {
      return false;
    }
    throw error;
  }
}

export async function releaseShortDramaSyncLease(): Promise<void> {
  const db = await getDatabase();
  await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: SYNC_STATE_ID, [`${SYNC_LEASE_SLOT}.task`]: SYNC_LEASE_TASK },
      { $set: { [SYNC_LEASE_SLOT]: null, updated_at: new Date().toISOString() } }
    );
}

/**
 * 请求取消任务：只在租约上置 cancel_requested 标记，任务循环在下一部剧
 * 的检查点看到后停止取新任务。当前正在处理的这部剧会跑完（采集不可
 * 半途中断）。
 */
export async function requestShortDramaSyncCancel(): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const result = await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      {
        id: SYNC_STATE_ID,
        [`${SYNC_LEASE_SLOT}.task`]: SYNC_LEASE_TASK,
        [`${SYNC_LEASE_SLOT}.expires_at`]: { $gt: now },
      },
      { $set: { [`${SYNC_LEASE_SLOT}.cancel_requested`]: true, updated_at: now } }
    );
  return result.modifiedCount === 1;
}

/** 读取并清除取消标记（任务循环检查点调用：读到即返回 true 并复位） */
export async function consumeShortDramaSyncCancel(): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const result = await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: SYNC_STATE_ID, [`${SYNC_LEASE_SLOT}.cancel_requested`]: true },
      { $set: { [`${SYNC_LEASE_SLOT}.cancel_requested`]: false, updated_at: now } }
    );
  return result.modifiedCount === 1;
}

/**
 * 清理残留任务状态（进程重启后租约/进度无人认领时）：清空租约槽位。
 * 返回是否清理了租约。
 */
export async function clearStaleShortDramaSyncLease(): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const result = await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: SYNC_STATE_ID, [SYNC_LEASE_SLOT]: { $ne: null } },
      { $set: { [SYNC_LEASE_SLOT]: null, updated_at: now } }
    );
  return result.modifiedCount === 1;
}

export interface ShortDramaLeaseProgress {
  stage: string;
  message: string;
  done?: number;
  total?: number;
}

/** 读取未过期的元数据同步租约；无 / 已过期返回 null（route 预检与展示共用） */
export function activeShortDramaSyncLease(
  state: ShortDramaSyncState | null
): ShortDramaTaskLease | null {
  const lease = state?.[SYNC_LEASE_SLOT] ?? null;
  return lease && new Date(lease.expires_at).getTime() > Date.now() ? lease : null;
}

/**
 * 写入当前租约的实时进度（管理端轮询 GET 读取展示）。
 * progress 写失败、租约已不存在（任务刚释放）时静默跳过——进度是
 * 尽力而为的展示数据，不能影响主任务。
 * options.extendTtlMs 同时顺延租约 TTL，防止长任务（全量补齐可超
 * 30 分钟）执行中途租约过期被并发任务抢锁。
 */
export async function updateShortDramaSyncLeaseProgress(
  progress: ShortDramaLeaseProgress,
  options?: { extendTtlMs?: number }
): Promise<void> {
  try {
    const db = await getDatabase();
    const now = new Date().toISOString();
    await db
      .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
      .updateOne(
        { id: SYNC_STATE_ID, [`${SYNC_LEASE_SLOT}.task`]: SYNC_LEASE_TASK },
        {
          $set: {
            [`${SYNC_LEASE_SLOT}.progress`]: {
              stage: progress.stage,
              message: progress.message.slice(0, 200),
              ...(progress.done !== undefined ? { done: progress.done } : {}),
              ...(progress.total !== undefined ? { total: progress.total } : {}),
              updated_at: now,
            },
            ...(options?.extendTtlMs
              ? {
                  [`${SYNC_LEASE_SLOT}.expires_at`]: new Date(
                    Date.now() + options.extendTtlMs
                  ).toISOString(),
                }
              : {}),
            updated_at: now,
          },
        }
      );
  } catch {
    // 进度是尽力而为的展示数据，任何写失败都不能影响主任务
  }
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
