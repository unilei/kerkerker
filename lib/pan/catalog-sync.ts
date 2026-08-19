import { getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import {
  getCategoryData,
  getCalendar,
  getHeroMovies,
  getLatestContent,
  getMoviesCategories,
  getNewContent,
  getTop250,
  getTVCategories,
  type HeroMovie,
  type Subject,
} from "@/lib/douban-service";
import { getKnownPanMovieTargets } from "@/lib/pan-resources-db";
import { syncPanResourcesForMovie } from "@/lib/pan/sync";

export const PAN_SYNC_TARGET_STATUSES = [
  "pending",
  "syncing",
  "synced",
  "empty",
  "failed",
] as const;

export type PanSyncTargetStatus = (typeof PAN_SYNC_TARGET_STATUSES)[number];

export interface PanSyncTargetDoc {
  _id?: unknown;
  douban_id: string;
  title: string;
  cover?: string;
  year?: string;
  internal_id?: number;
  status: PanSyncTargetStatus;
  attempts: number;
  resources_count: number;
  last_checked_at?: string;
  last_success_at?: string;
  last_error?: string;
  next_attempt_at?: string;
  claimed_by?: string;
  claim_expires_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PanSyncTarget {
  douban_id: string;
  title: string;
  cover?: string;
  year?: string;
  internal_id?: number;
  status: PanSyncTargetStatus;
  attempts: number;
  resources_count: number;
  last_checked_at?: string;
  last_success_at?: string;
  last_error?: string;
  next_attempt_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PanSyncTargetInput {
  douban_id: string;
  title: string;
  cover?: string;
  year?: string;
  internal_id?: number;
}

export interface PanSyncTargetStats {
  total: number;
  pending: number;
  syncing: number;
  synced: number;
  empty: number;
  failed: number;
}

export interface PanSyncTargetPage {
  items: PanSyncTarget[];
  total: number;
  page: number;
  limit: number;
  stats: PanSyncTargetStats;
}

const CLAIM_TTL_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const SITE_CATEGORIES = [
  "in_theaters",
  "hot_movies",
  "hot_tv",
  "us_tv",
  "jp_tv",
  "kr_tv",
  "anime",
  "documentary",
  "variety",
  "chinese_tv",
] as const;
const CATEGORY_PAGE_SIZE = 50;
const MAX_CATEGORY_PAGES = 20;
const CATEGORY_CONCURRENCY = 3;

function collection() {
  return getDatabase().then((db) =>
    db.collection<PanSyncTargetDoc>(COLLECTIONS.PAN_SYNC_TARGETS)
  );
}

function toTarget(doc: PanSyncTargetDoc): PanSyncTarget {
  return {
    douban_id: doc.douban_id,
    title: doc.title,
    cover: doc.cover,
    year: doc.year,
    internal_id: doc.internal_id,
    status: doc.status,
    attempts: doc.attempts || 0,
    resources_count: doc.resources_count || 0,
    last_checked_at: doc.last_checked_at,
    last_success_at: doc.last_success_at,
    last_error: doc.last_error,
    next_attempt_at: doc.next_attempt_at,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function normalizeInput(input: PanSyncTargetInput): PanSyncTargetInput | null {
  const doubanId = String(input.douban_id || "").trim();
  const title = String(input.title || "").trim();
  if (!/^\d{1,20}$/.test(doubanId) || !title) return null;
  const cover = typeof input.cover === "string" ? input.cover.trim() : "";
  const year = typeof input.year === "string" ? input.year.trim() : "";
  return {
    douban_id: doubanId,
    title: title.slice(0, 200),
    cover: cover || undefined,
    year: year || undefined,
    internal_id:
      typeof input.internal_id === "number" &&
      Number.isSafeInteger(input.internal_id)
        ? input.internal_id
        : undefined,
  };
}

export async function upsertPanSyncTargets(
  inputs: PanSyncTargetInput[]
): Promise<number> {
  const normalized = [
    ...new Map(
      inputs
        .map(normalizeInput)
        .filter((value): value is PanSyncTargetInput => value !== null)
        .map((value) => [value.douban_id, value] as const)
    ).values(),
  ];
  if (normalized.length === 0) return 0;

  const now = new Date().toISOString();
  const coll = await collection();
  const result = await coll.bulkWrite(
    normalized.map((input) => ({
      updateOne: {
        filter: { douban_id: input.douban_id },
        update: {
          $set: {
            title: input.title,
            ...(input.cover !== undefined ? { cover: input.cover } : {}),
            ...(input.year !== undefined ? { year: input.year } : {}),
            ...(input.internal_id !== undefined
              ? { internal_id: input.internal_id }
              : {}),
            updated_at: now,
          },
          $setOnInsert: {
            douban_id: input.douban_id,
            status: "pending" as const,
            attempts: 0,
            resources_count: 0,
            created_at: now,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );
  return result.upsertedCount + result.modifiedCount;
}

export async function getPanSyncTarget(
  doubanId: string
): Promise<PanSyncTarget | null> {
  const coll = await collection();
  const doc = await coll.findOne({ douban_id: doubanId });
  return doc ? toTarget(doc) : null;
}

export async function getPanSyncTargetStats(): Promise<PanSyncTargetStats> {
  const coll = await collection();
  const rows = await coll
    .aggregate<{ _id: PanSyncTargetStatus; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();
  const stats: PanSyncTargetStats = {
    total: 0,
    pending: 0,
    syncing: 0,
    synced: 0,
    empty: 0,
    failed: 0,
  };
  for (const row of rows) {
    if (row._id in stats) {
      stats[row._id as keyof PanSyncTargetStats] = row.count;
      stats.total += row.count;
    }
  }
  return stats;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listPanSyncTargets(options: {
  status?: PanSyncTargetStatus;
  keyword?: string;
  page?: number;
  limit?: number;
} = {}): Promise<PanSyncTargetPage> {
  const page = Math.max(Math.floor(options.page || 1), 1);
  const limit = Math.min(Math.max(Math.floor(options.limit || 20), 1), 100);
  const filter: Record<string, unknown> = {};
  if (options.status) filter.status = options.status;
  if (options.keyword?.trim()) {
    const pattern = new RegExp(escapeRegex(options.keyword.trim()), "i");
    filter.$or = [{ title: pattern }, { douban_id: options.keyword.trim() }];
  }

  const coll = await collection();
  const [docs, total, stats] = await Promise.all([
    coll
      .find(filter)
      .sort({
        status: 1,
        updated_at: -1,
      })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    coll.countDocuments(filter),
    getPanSyncTargetStats(),
  ]);
  return {
    items: docs.map(toTarget),
    total,
    page,
    limit,
    stats,
  };
}

export async function resetPanSyncTarget(doubanId: string): Promise<boolean> {
  const coll = await collection();
  const now = new Date().toISOString();
  const result = await coll.updateOne(
    { douban_id: doubanId },
    {
      $set: {
        status: "pending",
        next_attempt_at: now,
        updated_at: now,
      },
      $unset: {
        last_error: "",
        claimed_by: "",
        claim_expires_at: "",
      },
    }
  );
  return result.matchedCount > 0;
}

export async function claimPanSyncTarget(
  owner: string,
  doubanId?: string
): Promise<PanSyncTarget | null> {
  const coll = await collection();
  const now = new Date();
  const nowIso = now.toISOString();
  const filter: Record<string, unknown> = {
    $and: [
      doubanId ? { douban_id: doubanId } : {},
      {
        $or: [
          { status: "pending" },
          {
            status: "failed",
            $or: [
              { next_attempt_at: { $exists: false } },
              { next_attempt_at: { $lte: nowIso } },
            ],
          },
          {
            status: "syncing",
            $or: [
              { claim_expires_at: { $lte: nowIso } },
              { claim_expires_at: { $exists: false } },
            ],
          },
        ],
      },
    ],
  };
  const doc = await coll.findOneAndUpdate(
    filter,
    {
      $set: {
        status: "syncing",
        claimed_by: owner,
        claim_expires_at: new Date(now.getTime() + CLAIM_TTL_MS).toISOString(),
        updated_at: nowIso,
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { next_attempt_at: 1, updated_at: 1 },
      returnDocument: "after",
    }
  );
  return doc ? toTarget(doc) : null;
}

export async function finishPanSyncTarget(
  doubanId: string,
  owner: string,
  result: { resourcesCount: number; error?: string }
): Promise<boolean> {
  const coll = await collection();
  const now = new Date();
  const nowIso = now.toISOString();
  const failed = Boolean(result.error);
  const update: {
    $set: Record<string, unknown>;
    $unset: Record<string, "">;
  } = {
    $set: {
      status: failed ? "failed" : result.resourcesCount > 0 ? "synced" : "empty",
      resources_count: Math.max(0, Math.floor(result.resourcesCount || 0)),
      last_checked_at: nowIso,
      updated_at: nowIso,
      ...(failed
        ? {
            last_error: result.error?.slice(0, 1000),
            next_attempt_at: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
          }
        : { last_success_at: nowIso }),
    },
    $unset: {
      claimed_by: "",
      claim_expires_at: "",
      ...(failed ? {} : { last_error: "", next_attempt_at: "" }),
    },
  };
  const response = await coll.updateOne(
    { douban_id: doubanId, claimed_by: owner },
    update
  );
  return response.modifiedCount > 0;
}

export async function queueDuePanSyncTargets(
  maxAgeMs = 24 * 60 * 60 * 1000
): Promise<number> {
  const coll = await collection();
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - Math.max(maxAgeMs, 60_000)).toISOString();
  const result = await coll.updateMany(
    {
      status: { $in: ["synced", "empty"] },
      $or: [
        { last_checked_at: { $exists: false } },
        { last_checked_at: { $lt: cutoff } },
      ],
    },
    {
      $set: {
        status: "pending",
        next_attempt_at: nowIso,
        updated_at: nowIso,
      },
    }
  );
  return result.modifiedCount;
}

export interface SiteCatalogDiscovery {
  targets: PanSyncTargetInput[];
  sourceErrors: string[];
}

function addSubject(subjects: Map<string, PanSyncTargetInput>, subject: unknown) {
  if (!subject || typeof subject !== "object") return;
  const candidate = subject as {
    id?: unknown;
    title?: unknown;
    cover?: unknown;
  };
  const id = String(candidate.id || "").trim();
  const title = String(candidate.title || "").trim();
  if (!/^\d{1,20}$/.test(id) || !title) return;
  const previous = subjects.get(id);
  subjects.set(id, {
    douban_id: id,
    title,
    cover:
      typeof candidate.cover === "string"
        ? candidate.cover
        : previous?.cover,
  });
}

/**
 * 收集站内实际使用的影片目录，而不是把整个豆瓣作为同步范围。
 * 分类接口支持分页，先按站内分类拉取，再合并首页/最新快照并按 douban_id 去重。
 */
export async function discoverSiteMovieTargets(): Promise<SiteCatalogDiscovery> {
  const subjects = new Map<string, PanSyncTargetInput>();
  const sourceErrors: string[] = [];

  // 分类之间相互独立，限制并发以缩短首次发现时间，同时避免一次性打满上游。
  for (let offset = 0; offset < SITE_CATEGORIES.length; offset += CATEGORY_CONCURRENCY) {
    const categories = SITE_CATEGORIES.slice(offset, offset + CATEGORY_CONCURRENCY);
    const results = await Promise.all(
      categories.map(async (category) => {
        const found: Subject[] = [];
        let truncated = false;
        try {
          for (let page = 1; page <= MAX_CATEGORY_PAGES; page++) {
            const response = await getCategoryData(
              category,
              page,
              CATEGORY_PAGE_SIZE
            );
            if (!response || !Array.isArray(response.subjects)) {
              throw new Error("响应格式无效：subjects 必须是数组");
            }
            found.push(...response.subjects);
            const pagination = response.pagination;
            const hasMore =
              typeof pagination?.hasMore === "boolean"
                ? pagination.hasMore
                : response.subjects.length === CATEGORY_PAGE_SIZE;
            const reachedReportedTotal =
              typeof pagination?.total === "number" &&
              page * CATEGORY_PAGE_SIZE >= pagination.total;
            if (
              !hasMore ||
              !response.subjects?.length ||
              reachedReportedTotal ||
              page >= MAX_CATEGORY_PAGES
            ) {
              truncated =
                page >= MAX_CATEGORY_PAGES && hasMore;
              break;
            }
          }
          return { category, found, error: truncated ? "达到分页安全上限，目录可能不完整" : undefined };
        } catch (error) {
          return {
            category,
            found,
            error: error instanceof Error ? error.message : "请求失败",
          };
        }
      })
    );
    for (const result of results) {
      for (const subject of result.found) addSubject(subjects, subject);
    if (result.error) sourceErrors.push(`${result.category}: ${result.error}`);
    }
  }

  // 这些接口代表首页、电影页、电视剧页、最新页和日历页的实际展示快照；
  // 即使条目不属于上面的分类，也应进入站内同步台账。接口彼此独立，
  // 使用 allSettled 保留可用结果并把单个上游故障展示给后台。
  const snapshots = await Promise.allSettled([
    getLatestContent(),
    getMoviesCategories(),
    getTVCategories(),
    getNewContent(),
    getHeroMovies(),
    getTop250(),
    getCalendar(),
  ]);
  const snapshotLabels = [
    "latest",
    "movies",
    "tv",
    "new",
    "hero",
    "top250",
    "calendar",
  ];
  snapshots.forEach((snapshot, index) => {
    if (snapshot.status === "rejected") {
      sourceErrors.push(
        `${snapshotLabels[index]}: ${
          snapshot.reason instanceof Error ? snapshot.reason.message : "请求失败"
        }`
      );
      return;
    }
    const value = snapshot.value;
    const objectValue = value as unknown as {
      subjects?: unknown;
      days?: unknown;
    };
    if (Array.isArray(value)) {
      for (const group of value) {
        if (!group || typeof group !== "object") continue;
        const categoryGroup = group as { data?: unknown };
        if (Array.isArray(categoryGroup.data)) {
          for (const subject of categoryGroup.data) {
            addSubject(subjects, subject as Subject);
          }
        } else {
          addSubject(subjects, group as Subject | HeroMovie);
        }
      }
    } else if (Array.isArray(objectValue.subjects)) {
      for (const subject of objectValue.subjects) addSubject(subjects, subject as Subject);
    } else if (Array.isArray(objectValue.days)) {
      for (const day of objectValue.days as Array<{ entries?: unknown }>) {
        if (!day || !Array.isArray(day.entries)) continue;
        for (const entry of day.entries) {
          const id = String(entry?.douban_id || "").trim();
          const title = String(
            entry?.show_name_cn || entry?.show_name || ""
          ).trim();
          if (id && title) {
            addSubject(subjects, {
              id,
              title,
              cover: typeof entry?.poster === "string" ? entry.poster : "",
            });
          }
        }
      }
    } else {
      sourceErrors.push(`${snapshotLabels[index]}: 响应格式无效`);
    }
  });

  // 手工录入或历史自动同步过的影片即使暂时不在展示快照中，也属于站内
  // “已经收录”的范围；把它们并入台账，避免旧资源无法再次复核。
  try {
    const knownTargets = await getKnownPanMovieTargets();
    for (const target of knownTargets) {
      addSubject(subjects, {
        id: target.douban_id,
        title: target.title,
        cover: "",
      });
    }
  } catch (error) {
    sourceErrors.push(
      `pan_resources: ${error instanceof Error ? error.message : "读取已收录影片失败"}`
    );
  }

  return { targets: [...subjects.values()], sourceErrors };
}

export async function discoverAndEnqueuePanSyncTargets(): Promise<{
  discovered: number;
  upserted: number;
  sourceErrors: string[];
}> {
  const discovery = await discoverSiteMovieTargets();
  const upserted = await upsertPanSyncTargets(discovery.targets);
  return {
    discovered: discovery.targets.length,
    upserted,
    sourceErrors: discovery.sourceErrors,
  };
}

export interface PanSyncTargetBatchResult {
  processed: number;
  synced: number;
  empty: number;
  failed: number;
  imported: number;
  refreshed: number;
  disabled: number;
  remaining: number;
  stats: PanSyncTargetStats;
}

export interface PanSyncTargetBatchHooks {
  shouldContinue?: () => boolean | Promise<boolean>;
  onTargetStart?: (target: PanSyncTarget) => void | Promise<void>;
  onTargetComplete?: (
    target: PanSyncTarget,
    result: {
      status: "synced" | "empty" | "failed";
      imported: number;
      refreshed: number;
      disabled: number;
      error?: string;
    }
  ) => void | Promise<void>;
}

async function runBatchHook(work: (() => void | Promise<void>) | undefined) {
  if (!work) return;
  try {
    await work();
  } catch (error) {
    // 运行日志/进度属于旁路可观测性，写入失败不能把影片本身标为同步失败。
    console.error("记录影片同步进度失败:", error);
  }
}

export async function runPanSyncTargetBatch(
  limit = 5,
  owner = `catalog-${Date.now()}`,
  doubanId?: string,
  hooks: PanSyncTargetBatchHooks = {}
): Promise<PanSyncTargetBatchResult> {
  const bounded = Math.min(Math.max(Math.floor(limit || 1), 1), 20);
  let processed = 0;
  let synced = 0;
  let empty = 0;
  let failed = 0;
  let imported = 0;
  let refreshed = 0;
  let disabled = 0;

  for (let index = 0; index < bounded; index++) {
    if (hooks.shouldContinue && !(await hooks.shouldContinue())) break;
    const target = await claimPanSyncTarget(owner, doubanId);
    if (!target) break;
    processed++;
    await runBatchHook(() => hooks.onTargetStart?.(target));
    try {
      const result = await syncPanResourcesForMovie({
        doubanId: target.douban_id,
        title: target.title,
        year: target.year,
      });
      imported += result.imported;
      refreshed += result.refreshed ?? 0;
      disabled += result.disabled ?? 0;
      await finishPanSyncTarget(target.douban_id, owner, {
        resourcesCount: result.resourcesCount,
      });
      if (result.resourcesCount > 0) synced++;
      else empty++;
      await runBatchHook(() =>
        hooks.onTargetComplete?.(target, {
          status: result.resourcesCount > 0 ? "synced" : "empty",
          imported: result.imported,
          refreshed: result.refreshed ?? 0,
          disabled: result.disabled ?? 0,
        })
      );
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : "同步失败";
      await finishPanSyncTarget(target.douban_id, owner, {
        resourcesCount: 0,
        error: message,
      });
      await runBatchHook(() =>
        hooks.onTargetComplete?.(target, {
          status: "failed",
          imported: 0,
          refreshed: 0,
          disabled: 0,
          error: message,
        })
      );
    }
    if (doubanId) break;
  }

  const stats = await getPanSyncTargetStats();
  return {
    processed,
    synced,
    empty,
    failed,
    imported,
    refreshed,
    disabled,
    remaining: stats.pending + stats.failed,
    stats,
  };
}
