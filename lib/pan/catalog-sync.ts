import { getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import {
  getContentCalendar,
  getContentCatalog,
  type ContentHostExecutionOptions,
} from "@/lib/plugins/content-host";
import {
  getActivePluginProfileId,
  pluginProfileRegistry,
} from "@/lib/plugins/builtin-profiles";
import type {
  ContentCandidate,
  ContentCatalogCandidate,
  PluginPage,
} from "@/lib/plugins/types";
import { getKnownPanMovieTargets } from "@/lib/pan-resources-db";
import { syncPanResourcesForMovie } from "@/lib/pan/sync";
import { resolveContentIdentity } from "@/lib/content-identity-db";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";

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
  content_id?: string;
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
  content_id?: string;
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
  content_id?: string;
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
    content_id: doc.content_id,
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
  const contentId = typeof input.content_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.content_id)
    ? input.content_id
    : undefined;
  const cover = typeof input.cover === "string" ? input.cover.trim() : "";
  const year = typeof input.year === "string" ? input.year.trim() : "";
  return {
    douban_id: doubanId,
    content_id: contentId,
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

  // A caller may suggest content_id, but the host identity resolver is the
  // authority. Discovery without content_id remains allowed and is resolved
  // before the actual resource sync claims the target.
  const validated = await Promise.all(
    normalized.map(async (input) => {
      if (!input.content_id) return input;
      const identity = await resolveContentIdentity([
        { providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: input.douban_id },
      ]);
      if (input.content_id !== identity.contentId) {
        throw new Error("同步台账 content_id 与影片外部引用不一致");
      }
      return { ...input, content_id: identity.contentId };
    })
  );

  const now = new Date().toISOString();
  const coll = await collection();
  const result = await coll.bulkWrite(
    validated.map((input) => ({
      updateOne: {
        filter: { douban_id: input.douban_id },
        update: {
          $set: {
            title: input.title,
            ...(input.content_id ? { content_id: input.content_id } : {}),
            ...(input.cover !== undefined ? { cover: input.cover } : {}),
            ...(input.year !== undefined ? { year: input.year } : {}),
            ...(input.internal_id !== undefined
              ? { internal_id: input.internal_id }
              : {}),
            updated_at: now,
          },
          $setOnInsert: {
            douban_id: input.douban_id,
            ...(input.content_id ? { content_id: input.content_id } : {}),
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

export interface SiteCatalogDiscoveryOptions extends ContentHostExecutionOptions {
  shouldContinue?: () => boolean | Promise<boolean>;
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

function contentExecutionOptions(
  options: SiteCatalogDiscoveryOptions
): ContentHostExecutionOptions {
  return {
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
}

function candidateTitle(candidate: ContentCandidate): string {
  return candidate.titles[0]?.value?.trim() || "";
}

function addContentCandidate(
  subjects: Map<string, PanSyncTargetInput>,
  candidate: ContentCandidate
): "added" | "unresolved" | "incompatible" {
  const doubanRef = candidate.externalRefs.find(
    (reference) => reference.providerId === DOUBAN_CONTENT_PLUGIN_ID
  );
  if (!doubanRef) {
    return candidate.externalRefs.length > 0 ? "incompatible" : "unresolved";
  }
  const id = doubanRef.externalId.trim();
  const title = candidateTitle(candidate);
  if (!/^\d{1,20}$/.test(id) || !title) return "unresolved";
  const previous = subjects.get(id);
  const year = candidate.releaseDate?.match(/\b(?:19|20)\d{2}\b/)?.[0];
  subjects.set(id, {
    douban_id: id,
    title,
    cover: candidate.preview?.posterUrl || previous?.cover,
    year: year || previous?.year,
  });
  return "added";
}

async function discoverCategoryCandidates(
  category: string,
  options: SiteCatalogDiscoveryOptions
): Promise<CatalogPageScanResult> {
  return scanContentCatalogPages(
    (cursor) =>
      getContentCatalog(
        {
          view: "category",
          key: category,
          cursor,
          limit: CATEGORY_PAGE_SIZE,
        },
        contentExecutionOptions(options)
      ),
    MAX_CATEGORY_PAGES,
    options.shouldContinue
  );
}

export interface CatalogPageScanResult {
  items: ContentCatalogCandidate[];
  error?: string;
}

/** Follow provider-owned opaque cursors while preserving partial discovery on failure. */
export async function scanContentCatalogPages(
  fetchPage: (cursor?: string) => Promise<PluginPage<ContentCatalogCandidate>>,
  maxPages = MAX_CATEGORY_PAGES,
  shouldContinue?: () => boolean | Promise<boolean>
): Promise<CatalogPageScanResult> {
  const items: ContentCatalogCandidate[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 1; page <= maxPages; page++) {
      if (shouldContinue && !(await shouldContinue())) {
        throw new Error("目录发现已停止");
      }
      const response = await fetchPage(cursor);
      if (!response || !Array.isArray(response.items)) {
        throw new Error("响应格式无效：items 必须是数组");
      }
      items.push(...response.items);
      if (!response.hasMore) return { items };
      if (!response.nextCursor) {
        throw new Error("插件声明还有下一页，但没有返回 nextCursor");
      }
      if (cursors.has(response.nextCursor)) {
        throw new Error("插件返回了重复的目录游标");
      }
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
      if (page === maxPages) {
        return { items, error: "达到分页安全上限，目录可能不完整" };
      }
    }
  } catch (error) {
    return {
      items,
      error: error instanceof Error ? error.message : "请求失败",
    };
  }
  return { items };
}

/**
 * 收集站内实际使用的影片目录，而不是把整个豆瓣作为同步范围。
 * 分类接口支持分页，先按站内分类拉取，再合并首页/最新快照并按 douban_id 去重。
 */
export async function discoverSiteMovieTargets(
  options: SiteCatalogDiscoveryOptions = {}
): Promise<SiteCatalogDiscovery> {
  const subjects = new Map<string, PanSyncTargetInput>();
  const sourceErrors: string[] = [];

  // 分类之间相互独立，限制并发以缩短首次发现时间，同时避免一次性打满上游。
  for (let offset = 0; offset < SITE_CATEGORIES.length; offset += CATEGORY_CONCURRENCY) {
    if (options.shouldContinue && !(await options.shouldContinue())) {
      sourceErrors.push("catalog: 目录发现已停止");
      return { targets: [...subjects.values()], sourceErrors };
    }
    const categories = SITE_CATEGORIES.slice(offset, offset + CATEGORY_CONCURRENCY);
    const results = await Promise.all(
      categories.map(async (category) => ({
        category,
        ...(await discoverCategoryCandidates(category, options)),
      }))
    );
    for (const result of results) {
      let incompatible = 0;
      for (const candidate of result.items) {
        if (addContentCandidate(subjects, candidate) === "incompatible") incompatible++;
      }
      if (incompatible > 0) {
        sourceErrors.push(
          `${result.category}: ${incompatible} 条内容不属于当前 Douban 兼容身份空间`
        );
      }
      if (result.error) sourceErrors.push(`${result.category}: ${result.error}`);
    }
  }

  // 这些接口代表首页、电影页、电视剧页、最新页和日历页的实际展示快照；
  // 即使条目不属于上面的分类，也应进入站内同步台账。接口彼此独立，
  // 使用 allSettled 保留可用结果并把单个上游故障展示给后台。
  if (options.shouldContinue && !(await options.shouldContinue())) {
    sourceErrors.push("catalog: 目录发现已停止");
    return { targets: [...subjects.values()], sourceErrors };
  }
  const profileId = options.profileId || getActivePluginProfileId();
  const profile = pluginProfileRegistry.require(profileId);
  const today = new Date();
  const through = new Date(today);
  through.setUTCDate(through.getUTCDate() + 6);
  const execution = contentExecutionOptions({ ...options, profileId });
  const snapshotSources: Array<{
    label: string;
    load: () => Promise<PluginPage<ContentCandidate>>;
  }> = [
    {
      label: "latest",
      load: () => getContentCatalog({ view: "latest", limit: 50 }, execution),
    },
    {
      label: "movies",
      load: () => getContentCatalog({ view: "sections", key: "movies" }, execution),
    },
    {
      label: "series",
      load: () => getContentCatalog({ view: "sections", key: "series" }, execution),
    },
    {
      label: "new-releases",
      load: () => getContentCatalog({ view: "new-releases" }, execution),
    },
    {
      label: "featured",
      load: () => getContentCatalog({ view: "featured" }, execution),
    },
    {
      label: "top250",
      load: () =>
        getContentCatalog({ view: "category", key: "top250", limit: 50 }, execution),
    },
    {
      label: "calendar",
      load: () =>
        getContentCalendar(
          {
            from: today.toISOString().slice(0, 10),
            to: through.toISOString().slice(0, 10),
            region: profile.region,
          },
          execution
        ),
    },
  ];
  const snapshots = await Promise.allSettled(
    snapshotSources.map((source) => source.load())
  );
  snapshots.forEach((snapshot, index) => {
    const label = snapshotSources[index].label;
    if (snapshot.status === "rejected") {
      sourceErrors.push(
        `${label}: ${
          snapshot.reason instanceof Error ? snapshot.reason.message : "请求失败"
        }`
      );
      return;
    }
    const value = snapshot.value;
    if (!value || !Array.isArray(value.items)) {
      sourceErrors.push(`${label}: 响应格式无效`);
      return;
    }
    let incompatible = 0;
    for (const candidate of value.items) {
      if (addContentCandidate(subjects, candidate) === "incompatible") incompatible++;
    }
    if (incompatible > 0) {
      sourceErrors.push(
        `${label}: ${incompatible} 条内容不属于当前 Douban 兼容身份空间`
      );
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

export async function discoverAndEnqueuePanSyncTargets(
  options: SiteCatalogDiscoveryOptions = {}
): Promise<{
  discovered: number;
  upserted: number;
  sourceErrors: string[];
}> {
  const discovery = await discoverSiteMovieTargets(options);
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
  /** Execution metadata forwarded to the cloud-drive host for each target. */
  execution?: ContentHostExecutionOptions;
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
    const claimed = await claimPanSyncTarget(owner, doubanId);
    if (!claimed) break;
    let target: PanSyncTarget = claimed;
    processed++;
    await runBatchHook(() => hooks.onTargetStart?.(target));
    try {
      const identity = await resolveContentIdentity([
        { providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: target.douban_id },
      ]);
      if (target.content_id && target.content_id !== identity.contentId) {
        throw new Error("同步台账 content_id 与外部引用映射冲突，需要人工处理");
      }
      if (!target.content_id) {
        await (await collection()).updateOne(
          { douban_id: target.douban_id, claimed_by: owner },
          { $set: { content_id: identity.contentId, updated_at: new Date().toISOString() } }
        );
        target = { ...target, content_id: identity.contentId };
      }
      const result = await syncPanResourcesForMovie({
        doubanId: target.douban_id,
        contentId: target.content_id,
        title: target.title,
        year: target.year,
        shouldContinue: hooks.shouldContinue,
        contentExecution: hooks.execution || { runId: owner },
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
