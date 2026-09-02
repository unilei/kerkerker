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
 * 抓取器按 (source, source_article_id) 幂等 upsert；转存流水线更新
 * 状态机与元数据关联；前台按标签/搜索/时间分页读取（只读公开）。
 * 公开读路径（详情/标签聚合/相关推荐/sitemap）走进程内 TTL 缓存，
 * 由下方写函数 bumpShortDramaCache() 即时失效。
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

  // 重抓刷新字段放 $set（源站可能补标签/换链接/补发布日期）；初始创建
  // 字段放 $setOnInsert。同一路径绝不能同时出现在 $set 与 $setOnInsert
  // （Mongo 报 ConflictingUpdateOperators）。
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
        // publish_date/episode_count 放 $set：重抓即可回填早期缺失的日期
        //（解析增强后），值与源站一致时写回无副作用
        ...(input.publish_date
          ? { publish_date: boundedText(input.publish_date, 10) }
          : {}),
        ...(Number.isInteger(input.episode_count)
          ? { episode_count: input.episode_count }
          : {}),
      },
      $setOnInsert: {
        source: input.source,
        source_article_id: input.source_article_id,
        title,
        ...(providedTags.length === 0 ? { tags: [] } : {}),
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
  bumpShortDramaCache();
  return { drama: toView(doc), created: !doc.created_at || doc.created_at === now };
}

export interface ShortDramaListQuery {
  tag?: string;
  search?: string;
  status?: ShortDramaStatus;
  /** 多状态筛选（后台待转存列表：discovered + failed） */
  statuses?: ShortDramaStatus[];
  /** 只列已有自有网盘链接的（/all 分页页与 sitemap 同口径，保证总页数一致） */
  hasOwnShareUrl?: boolean;
  page?: number;
  limit?: number;
  /**
   * 覆写默认 100 的 limit 钳制：仅供后台范围转存批量取整个页码区间的
   * 队列用；公开接口保持 100 上限，防止外部一次拉走大半张表
   */
  limitMax?: number;
  includeDisabled?: boolean;
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
      // 前台排序（全序）：源站发布日期新的在前；无日期的退回 created_at
      // （抓取按源站发布顺序遍历，顺序语义一致）；_id 兜底保证同键文档
      // 顺序稳定，是 keyset 分页不重不漏的前提（source_article_id 是字
      // 符串，字典序与数值序不一致，不能作排序键）
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
  if (!query.includeDisabled) filter.enabled = true;
  if (query.status) filter.status = query.status;
  else if (query.statuses && query.statuses.length > 0) {
    filter.status = { $in: query.statuses };
  }
  if (query.tag) filter.tags = boundedText(query.tag, 40);
  if (query.hasOwnShareUrl) filter.own_share_url = { $type: "string" };
  if (query.search) {
    const search = boundedText(query.search, 100);
    if (search) filter.title = { $regex: escapeRegex(search), $options: "i" };
  }
  return filter;
}

/** Sitemap 用：可公开访问（done 且已有自有网盘链接）的短剧，只投影 id 与时间字段 */
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
            enabled: true,
            status: "done" as ShortDramaStatus,
            own_share_url: { $type: "string" },
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
        .findOne({ _id: new ObjectId(id), enabled: true });
      return doc ? toView(doc) : null;
    }
  );
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
  if (result.modifiedCount === 1) bumpShortDramaCache();
  return result.modifiedCount === 1;
}

/** 转存流水线取下一批待转存短剧（discovered 优先，failed 可重试；最新发布的先转） */
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
    // 容量有限时优先转存最新发布的（与前台展示顺序一致）
    .sort({ publish_date: -1, created_at: -1 })
    .limit(Math.min(Math.max(limit, 1), 50))
    .toArray();
  return docs.map(toView);
}

/**
 * 元数据补齐队列过滤器（纯函数，供单测）：
 * 任一三件套「值缺失（字段不存在或为 null）且未被 missing_at_source 豁免」
 * 的 done 条目。{ field: null } 同时匹配字段缺失与显式 null；
 * { metadata_missing…: { $ne } } 对数组字段=「不含该元素」，对缺省字段恒真。
 */
const METADATA_PIECE_FIELDS: ReadonlyArray<readonly [ShortDramaMetadataPiece, string]> = [
  ["cover", "cover_url"],
  ["intro", "intro"],
  ["metadata", "metadata"],
];

export function shortDramaMetadataBackfillFilter(): Record<string, unknown> {
  return {
    enabled: true,
    status: "done",
    own_folder_fid: { $type: "string" },
    $or: METADATA_PIECE_FIELDS.map(([piece, field]) => ({
      $and: [
        { $or: [{ [field]: { $exists: false } }, { [field]: null }] },
        { missing_at_source: { $ne: piece } },
      ],
    })),
  };
}

/**
 * 元数据补齐取队列：转存完成但缺三件套（且未被源缺失标记豁免）的条目，
 * 与前台同序（发布日期新→旧）——先补首屏可见的，补完立刻能在首页看到。
 * limit 上限放宽到 5 万：后台全量补齐要一次取完整个队列。
 */
export async function takeShortDramasForMetadataBackfill(
  limit: number
): Promise<ShortDrama[]> {
  const db = await getDatabase();
  const docs = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .find(shortDramaMetadataBackfillFilter() as Filter<ShortDramaDoc>)
    .sort({ publish_date: -1, created_at: -1, updated_at: -1 })
    .limit(Math.min(Math.max(limit, 1), 50_000))
    .toArray();
  return docs.map(toView);
}

/** 按后台勾选的 id 精确取短剧（单个/批量转存与删除用；含 disabled） */
export async function getShortDramasByIds(ids: string[]): Promise<ShortDrama[]> {
  const objectIds = ids
    .filter((id) => typeof id === "string" && ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id))
    .map((id) => new ObjectId(id));
  if (objectIds.length === 0) return [];
  const db = await getDatabase();
  const docs = await db
    .collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS)
    .find({ _id: { $in: objectIds } })
    // 转存按发布日期新→旧执行，与待转存列表顺序一致
    .sort({ publish_date: -1, created_at: -1 })
    .limit(200)
    .toArray();
  return docs.map(toView);
}

/** 删除本地短剧记录（网盘文件由调用方先行清理）；返回实际删除的文档 */
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
  /** 把这些部件标记为「源分享夹里确认不存在」（补齐队列随后豁免它们） */
  missing_at_source?: ShortDramaMetadataPiece[];
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
  if (patch.missing_at_source) {
    // 整组覆盖：每次以本轮列目录的核实结果为准（部件找到即移出标记）
    const pieces = patch.missing_at_source.filter((piece) =>
      (["cover", "intro", "metadata"] as const).includes(piece)
    );
    set.missing_at_source = pieces;
  }
  if (patch.transfer_error) set.transfer_error = patch.transfer_error.slice(0, 2000);
  if (patch.clear_transfer_error) set.transfer_error = null;

  const inc: Record<string, number> = {};
  if (patch.status === "transferring") inc.transfer_attempts = 1;

  await db.collection<ShortDramaDoc>(COLLECTIONS.SHORT_DRAMAS).updateOne(
    { _id: new ObjectId(id) },
    inc.transfer_attempts > 0 ? { $set: set, $inc: inc } : { $set: set }
  );
  bumpShortDramaCache();
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

/**
 * 标签聚合计数——公开口径（done 且已有自有网盘链接，与详情页可达性一致）。
 * 标签落地页/目录/sitemap 都以这里的数据为准；listShortDramaTagCounts
 * 是「全部 enabled」口径，仅菜单展示用。
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
              enabled: true,
              status: "done" as ShortDramaStatus,
              own_share_url: { $type: "string" },
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
          enabled: true,
          status: "done" as ShortDramaStatus,
          own_share_url: { $type: "string" },
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

/**
 * 任务租约：防同类任务并发跑批（内存多实例由 expires_at 兜底）。
 * 抓取与转存各持一把独立租约（running_scrape / running_transfer），
 * 两类任务可并行；同任务（scrape/scrape、transfer/transfer，含删除
 * 与元数据补齐复用 transfer 租约）仍互斥。
 */
const LEASE_SLOT_BY_TASK: Record<"scrape" | "transfer", "running_scrape" | "running_transfer"> = {
  scrape: "running_scrape",
  transfer: "running_transfer",
};

export async function tryAcquireShortDramaLease(
  task: "scrape" | "transfer",
  ttlMs: number
): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const slot = LEASE_SLOT_BY_TASK[task];
  const collection = db.collection<ShortDramaSyncState>(
    COLLECTIONS.SHORT_DRAMA_SYNC_STATE
  );

  // 过期租约直接清除（本槽位）；旧版单槽 running 一并清掉（迁移）
  const staleFilter: Record<string, unknown> = {
    id: SYNC_STATE_ID,
    [`${slot}.expires_at`]: { $lte: now },
  };
  await collection.updateOne(
    staleFilter,
    { $set: { [slot]: null, running: null, updated_at: now } }
  );
  await collection.updateOne(
    { id: SYNC_STATE_ID, running: { $ne: null } },
    { $set: { running: null, updated_at: now } }
  );

  try {
    const result = await collection.updateOne(
      { id: SYNC_STATE_ID, [slot]: null },
      {
        $set: {
          [slot]: {
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
  } catch (error) {
    // 租约被未过期同类任务持有时 filter 不命中，upsert 会撞 id 唯一索引：
    // 这里的语义等价于「已有同类任务在运行」，不能向上抛 500
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

export async function releaseShortDramaLease(
  task: "scrape" | "transfer"
): Promise<void> {
  const db = await getDatabase();
  const slot = LEASE_SLOT_BY_TASK[task];
  await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: SYNC_STATE_ID, [`${slot}.task`]: task },
      { $set: { [slot]: null, updated_at: new Date().toISOString() } }
    );
}

/**
 * 请求取消任务：只在租约上置 cancel_requested 标记，任务循环在下一部剧
 * 的检查点（tryAcquire 之后的每轮开头）看到后停止取新任务。
 * 当前正在处理的这部剧会跑完（转存不可半途中断，中断会留脏数据）。
 */
export async function requestShortDramaTaskCancel(
  task: "scrape" | "transfer"
): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const slot = LEASE_SLOT_BY_TASK[task];
  const result = await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      {
        id: SYNC_STATE_ID,
        [`${slot}.task`]: task,
        [`${slot}.expires_at`]: { $gt: now },
      },
      { $set: { [`${slot}.cancel_requested`]: true, updated_at: now } }
    );
  return result.modifiedCount === 1;
}

/** 读取并清除取消标记（任务循环检查点调用：读到即返回 true 并复位） */
export async function consumeShortDramaTaskCancel(
  task: "scrape" | "transfer"
): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const slot = LEASE_SLOT_BY_TASK[task];
  const result = await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: SYNC_STATE_ID, [`${slot}.cancel_requested`]: true },
      { $set: { [`${slot}.cancel_requested`]: false, updated_at: now } }
    );
  return result.modifiedCount === 1;
}

/**
 * 清理残留任务状态（进程重启后租约/进度无人认领时）：
 * 清空租约槽位，并把卡在 transferring 超过安全时长的剧复位为 discovered。
 * 返回是否清理了租约。
 */
export async function clearStaleShortDramaLease(
  task: "scrape" | "transfer"
): Promise<boolean> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const slot = LEASE_SLOT_BY_TASK[task];
  const result = await db
    .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
    .updateOne(
      { id: SYNC_STATE_ID, [slot]: { $ne: null } },
      { $set: { [slot]: null, updated_at: now } }
    );
  if (task === "transfer" && result.modifiedCount === 1) {
    // 卡在 transferring 的剧复位（10 分钟安全时长，防误伤真在跑的条目）
    await db
      .collection(COLLECTIONS.SHORT_DRAMAS)
      .updateMany(
        {
          status: "transferring",
          updated_at: { $lt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
        },
        { $set: { status: "discovered", updated_at: now } }
      );
  }
  return result.modifiedCount === 1;
}

export interface ShortDramaLeaseProgress {
  stage: string;
  message: string;
  done?: number;
  total?: number;
}

/** 读取指定任务未过期的租约；无 / 已过期返回 null（route 预检与展示共用） */
export function activeShortDramaLease(
  state: ShortDramaSyncState | null,
  task: "scrape" | "transfer"
): ShortDramaTaskLease | null {
  const slot = LEASE_SLOT_BY_TASK[task];
  const lease = state?.[slot] ?? null;
  return lease && new Date(lease.expires_at).getTime() > Date.now() ? lease : null;
}

/**
 * 写入当前租约的实时进度（管理端轮询 GET 读取展示）。
 * progress 写失败、租约已不存在（任务刚释放）时静默跳过——进度是
 * 尽力而为的展示数据，不能影响主任务。
 * options.extendTtlMs 同时顺延租约 TTL，防止长任务（全量回填可超
 * 30 分钟）执行中途租约过期被并发任务抢锁。
 */
export async function updateShortDramaLeaseProgress(
  task: "scrape" | "transfer",
  progress: ShortDramaLeaseProgress,
  options?: { extendTtlMs?: number }
): Promise<void> {
  try {
    const db = await getDatabase();
    const now = new Date().toISOString();
    const slot = LEASE_SLOT_BY_TASK[task];
    await db
      .collection<ShortDramaSyncState>(COLLECTIONS.SHORT_DRAMA_SYNC_STATE)
      .updateOne(
        { id: SYNC_STATE_ID, [`${slot}.task`]: task },
        {
          $set: {
            [`${slot}.progress`]: {
              stage: progress.stage,
              message: progress.message.slice(0, 200),
              ...(progress.done !== undefined ? { done: progress.done } : {}),
              ...(progress.total !== undefined ? { total: progress.total } : {}),
              updated_at: now,
            },
            ...(options?.extendTtlMs
              ? {
                  [`${slot}.expires_at`]: new Date(
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
