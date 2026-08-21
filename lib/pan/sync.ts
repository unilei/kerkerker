/**
 * kkpans → pan_resources 同步引擎（服务端专用）
 *
 * - 增量（incremental）：拉 kkpans 最新一页转存成功资源，
 *   按 kkpan_id/url 去重后，通过豆瓣搜索把资源名匹配到影片再入库
 * - 补库（backfill）：从豆瓣热榜取影片列表，逐片搜索 kkpans，
 *   严格片名匹配后入库（不需要豆瓣反向匹配）
 * - 失效检测：kkpan 来源的资源按片名回查 kkpans 目录，
 *   链接已消失的自动禁用（搜索无结果时不判死，避免误伤）
 */

import {
  cleanKkpanTitle,
  formatBytes,
  extractTitleCandidate,
  extractYear,
  titlesStrictlyMatch,
  type KkpanPageResult,
  type KkpanResource,
} from "@/lib/kkpan";
import {
  listCloudDriveTaskPage,
  searchCloudDriveTaskPage,
} from "@/lib/pan/cloud-drive-task";
import {
  getContentCatalog,
  searchContent,
  type ContentHostExecutionOptions,
} from "@/lib/plugins/content-host";
import type { ContentCandidate } from "@/lib/plugins/types";
import {
  createPanResourceInDB,
  countEnabledPanResourcesByDoubanId,
  getExistingPanKeys,
  getExistingPanKeysForCandidates,
  getKkpanSourceResources,
  getKkpanSourceResourcesByDoubanId,
  getPanSyncState,
  updatePanResourceInDB,
  savePanSyncState,
} from "@/lib/pan-resources-db";
import { PAN_BRANDS, type PanBrand } from "@/types/pan-resource";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import { resolveContentIdentity } from "@/lib/content-identity-db";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";

const FORMAT_RE = /\b(MP4|MKV|AVI|MOV|RMVB|WMV|FLV|WEBM|ISO|TS)\b/i;

export interface SyncStats {
  mode: "incremental" | "backfill";
  pulled: number; // kkpans 拉到的有效资源数
  imported: number; // 新入库
  skippedExisting: number; // 已存在跳过
  unmatched: number; // 未能匹配影片而跳过
  disabled: number; // 失效禁用
  refreshed: number; // 失效检测中链接换新（url 更新而非禁用）
  checkedTitles: number; // 失效检测覆盖的影片数
  durationMs: number;
  // 错误统计（用于补库模式的整体成功判断，避免上游全故障时仍报"成功"）
  categoryErrors?: number; // 豆瓣分类请求失败次数
  searchErrors?: number; // 单片 kkpans 搜索失败次数
  doubanErrors?: number; // 增量模式豆瓣搜索失败次数
  sourceErrors?: number; // kkpans 目录/失效检测失败次数
  // 整体是否认定为失败（上游全故障 / 无任何有效数据时为 true）
  failed?: boolean;
  cancelled?: boolean;
}

type SyncContinuation = () => boolean | Promise<boolean>;

function brandOf(item: KkpanResource): PanBrand | null {
  return (PAN_BRANDS as string[]).includes(item.targetPlatform)
    ? (item.targetPlatform as PanBrand)
    : null;
}

// 入库一条 kkpan 资源。返回是否首次写入（true）；若库内已有同 kkpan_id
// （并发同步撞库或水位回拉），返回 false，调用方据此精确统计 imported。
async function importKkpanItem(
  item: KkpanResource,
  doubanId: string,
  movieTitle: string,
  contentId?: string
): Promise<boolean> {
  const identity = await resolveContentIdentity([
    { providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: doubanId },
  ]);
  if (contentId && contentId !== identity.contentId) {
    throw new Error("同步资源 content_id 与影片身份冲突，需要人工处理");
  }
  const { created } = await createPanResourceInDB({
    douban_id: doubanId,
    content_id: identity.contentId,
    movie_title: movieTitle,
    brand: brandOf(item) as PanBrand,
    title: cleanKkpanTitle(item.fileName),
    url: item.shareLink,
    code: item.shareCode?.toUpperCase() || undefined,
    size: formatBytes(item.fileSize),
    format: item.fileName.match(FORMAT_RE)?.[1]?.toUpperCase(),
    source: "kkpan",
    provider_id: KKPAN_PLUGIN_ID,
    provider_resource_id: String(item.id),
    kkpan_id: item.id,
  });
  return created;
}

export interface MoviePanSyncResult {
  matched: number;
  imported: number;
  skippedExisting: number;
  resourcesCount: number;
  refreshed: number;
  disabled: number;
}

/**
 * 按单部站内影片同步 kkpans 资源。全量台账、单片重试和每日批处理都复用
 * 这一入口，避免三套标题匹配/去重逻辑逐渐分叉。
 */
export async function syncPanResourcesForMovie(input: {
  doubanId: string;
  contentId?: string;
  title: string;
  year?: string;
  shouldContinue?: SyncContinuation;
  contentExecution?: ContentHostExecutionOptions;
}): Promise<MoviePanSyncResult> {
  const identity = await resolveContentIdentity([
    { providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: input.doubanId },
  ]);
  if (input.contentId && input.contentId !== identity.contentId) {
    throw new Error("同步资源 content_id 与影片身份冲突，需要人工处理");
  }
  const contentId = identity.contentId;
  const catalog = await scanStablePages(
    (page) =>
      searchCloudDriveTaskPage(input.title, 50, page, input.contentExecution),
    50,
    INCREMENTAL_MAX_PAGES,
    input.shouldContinue
  );
  const existing = await getExistingPanKeysForCandidates({
    urls: catalog.items.map((item) => item.shareLink),
    kkpanIds: catalog.items.map((item) => item.id),
  });
  const linkedForMovie = (await getKkpanSourceResourcesByDoubanId(input.doubanId)).filter(
    (resource) =>
      Number.isSafeInteger(resource.kkpan_id) &&
      (resource.kkpan_id as number) > 0
  );
  const linkedByKkpanId = new Map(
    linkedForMovie.map((resource) => [resource.kkpan_id as number, resource])
  );
  let matched = 0;
  let imported = 0;
  let skippedExisting = 0;
  let refreshed = 0;
  let disabled = 0;
  const liveIds = new Set<number>();
  let hasReliableMatch = false;

  for (const item of catalog.items) {
    if (!brandOf(item)) continue;
    const candidate = extractTitleCandidate(item.fileName);
    const titleMatches = titlesStrictlyMatch(candidate, input.title);
    const linkedResource = linkedByKkpanId.get(item.id);
    // 已经绑定到本片的 kkpan_id 是可靠关联，即使源文件改名后候选片名
    // 不再匹配，也要用于恢复/刷新；新资源仍必须通过严格片名匹配。
    if (!titleMatches && !linkedResource) continue;
    if (
      linkedResource?.content_id &&
      linkedResource.content_id !== contentId
    ) {
      throw new Error("网盘资源 content_id 与影片身份冲突，需要人工处理");
    }
    const itemYear = extractYear(item.fileName);
    if (titleMatches && !linkedResource && input.year && itemYear) {
      const diff = Math.abs(Number(input.year) - Number(itemYear));
      if (Number.isFinite(diff) && diff > 1) continue;
    }
    matched++;
    hasReliableMatch = true;
    liveIds.add(item.id);
    if (linkedResource) {
      const liveCode = item.shareCode?.trim().toUpperCase() || null;
      const storedCode = linkedResource.code?.trim().toUpperCase() || null;
      const update: {
        url?: string;
        code?: string;
        clear_code?: boolean;
        content_id?: string;
        provider_id?: string;
        provider_resource_id?: string;
        enabled: boolean;
      } = { enabled: true };
      if (item.shareLink !== linkedResource.url && item.shareLink) {
        update.url = item.shareLink;
      }
      if (liveCode !== storedCode) {
        if (liveCode) update.code = liveCode;
        else update.clear_code = true;
      }
      if (
        linkedResource.provider_id !== KKPAN_PLUGIN_ID ||
        linkedResource.provider_resource_id !== String(item.id)
      ) {
        update.provider_id = KKPAN_PLUGIN_ID;
        update.provider_resource_id = String(item.id);
      }
      if (
        update.url !== undefined ||
        update.code !== undefined ||
        update.clear_code ||
        !linkedResource.enabled ||
        update.provider_id !== undefined ||
        linkedResource.content_id !== contentId
      ) {
        if (linkedResource.content_id !== contentId) {
          update.content_id = contentId;
        }
        if (await updatePanResourceInDB(linkedResource.id, update)) {
          refreshed++;
        }
      }
      skippedExisting++;
      continue;
    }
    if (existing.kkpanIds.has(item.id) || existing.urls.has(item.shareLink)) {
      skippedExisting++;
      continue;
    }
    const created = await importKkpanItem(
      item,
      input.doubanId,
      input.title,
      contentId
    );
    existing.kkpanIds.add(item.id);
    existing.urls.add(item.shareLink);
    if (created) imported++;
    else skippedExisting++;
  }

  // 只有搜索返回了可靠的本片结果，才把本片历史资源中不再出现的条目标记
  // 为禁用；空结果/标题偏差不能证明资源失效，避免误伤。
  if (hasReliableMatch) {
    for (const resource of linkedForMovie) {
      const kkpanId = resource.kkpan_id as number;
      if (!liveIds.has(kkpanId) && resource.enabled) {
        if (await updatePanResourceInDB(resource.id, { enabled: false })) {
          disabled++;
        }
      }
    }
  }

  return {
    matched,
    imported,
    skippedExisting,
    resourcesCount: await countEnabledPanResourcesByDoubanId(input.doubanId),
    refreshed,
    disabled,
  };
}

export function getLegacyDoubanCandidate(
  candidate: ContentCandidate
): { doubanId: string; title: string; year?: string } | null {
  const reference = candidate.externalRefs.find(
    (item) => item.providerId === DOUBAN_CONTENT_PLUGIN_ID
  );
  const doubanId = reference?.externalId.trim() || "";
  const title = candidate.titles[0]?.value?.trim() || "";
  if (!/^\d{1,20}$/.test(doubanId) || !title) return null;
  return {
    doubanId,
    title,
    year: candidate.releaseDate?.match(/\b(?:19|20)\d{2}\b/)?.[0],
  };
}

// 资源名 → 当前内容插件影片匹配（严格片名 + 年份容差 ±1，取前 5 个候选）。
// 持久层迁移期只接受精确的 Douban 外部引用，避免把 TMDB ID 写进 douban_id。
export async function matchContentForTitle(
  rawTitle: string,
  year?: string,
  execution: ContentHostExecutionOptions = {}
): Promise<{ doubanId: string; title: string } | null> {
  const result = await searchContent(
    {
      query: rawTitle,
      intent: "resource-match",
      limit: 5,
    },
    execution
  );
  let incompatible = false;
  for (const item of result.items.slice(0, 5)) {
    const candidate = getLegacyDoubanCandidate(item);
    if (!candidate) {
      if (item.externalRefs.length > 0) incompatible = true;
      continue;
    }
    if (!titlesStrictlyMatch(candidate.title, rawTitle)) continue;
    if (year && candidate.year) {
      const diff = Math.abs(Number(candidate.year) - Number(year));
      if (Number.isFinite(diff) && diff > 1) continue;
    }
    return { doubanId: candidate.doubanId, title: candidate.title };
  }
  if (incompatible) {
    throw new Error("当前同步存储仍只兼容 Douban 外部引用，不能写入其他内容源 ID");
  }
  return null;
}

const INCREMENTAL_PAGE_SIZE = 50;
const INCREMENTAL_MAX_PAGES = 200;

function normalizeSyncLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), 500);
}

function isValidWatermark(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function compareUpdatedAt(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime - bTime;
  return a.localeCompare(b);
}

interface StablePageScan {
  items: KkpanResource[];
  total?: number;
}

// kkpans 使用 offset/page 分页且不提供快照 token。完整扫描时额外重读第一页，
// 并校验 total、第一页指纹、跨页唯一 ID 数；扫描期间发生插入/更新导致页面漂移时
// 整轮失败，不推进水位，也不用于失效禁用。
export async function scanStablePages(
  fetchPage: (page: number) => Promise<KkpanPageResult>,
  pageSize: number,
  maxPages: number,
  shouldContinue?: SyncContinuation
): Promise<StablePageScan> {
  if (shouldContinue && !(await shouldContinue())) throw new Error("同步任务已停止");
  const first = await fetchPage(1);
  const scannedPages: KkpanPageResult[] = [first];
  const rawIds = new Set<number>();
  const items = new Map<number, KkpanResource>();
  let duplicateId = false;
  let complete = false;

  const collect = (result: KkpanPageResult) => {
    if (result.rawIds.length !== result.rawCount) {
      throw new Error("kkpans 分页响应缺少有效资源 ID");
    }
    for (const id of result.rawIds) {
      if (rawIds.has(id)) duplicateId = true;
      rawIds.add(id);
    }
    for (const item of result.items) {
      const previous = items.get(item.id);
      if (!previous || compareUpdatedAt(item.updatedAt, previous.updatedAt) > 0) {
        items.set(item.id, item);
      }
    }
  };

  collect(first);
  if (first.rawCount < pageSize) complete = true;

  for (let page = 2; !complete && page <= maxPages; page++) {
    if (shouldContinue && !(await shouldContinue())) throw new Error("同步任务已停止");
    const result = await fetchPage(page);
    scannedPages.push(result);
    collect(result);
    if (result.rawCount < pageSize) complete = true;
  }

  if (!complete) {
    throw new Error(`kkpans 分页超过安全上限 ${maxPages} 页`);
  }

  // offset 分页的漂移可能发生在任意页，不能只确认第一页。重新读取本轮实际
  // 访问过的所有页，并逐页比较原始 ID、数量、指纹和 total；否则“第 2 页
  // 替换一条、总数不变”的情况仍会漏项并把有效资源误判为失效。
  for (let page = 1; page <= scannedPages.length; page++) {
    if (shouldContinue && !(await shouldContinue())) throw new Error("同步任务已停止");
    const confirmation = await fetchPage(page);
    const original = scannedPages[page - 1];
    const idsStable =
      confirmation.rawIds.length === original.rawIds.length &&
      confirmation.rawIds.every((id, index) => id === original.rawIds[index]);
    if (
      confirmation.total !== original.total ||
      confirmation.rawCount !== original.rawCount ||
      confirmation.fingerprint !== original.fingerprint ||
      !idsStable
    ) {
      throw new Error("kkpans 分页扫描期间目录发生变化，请稍后重试");
    }
  }

  const countMatchesTotal =
    first.total === undefined || rawIds.size === first.total;
  if (
    duplicateId ||
    !countMatchesTotal
  ) {
    throw new Error("kkpans 分页扫描期间目录发生变化，请稍后重试");
  }

  return { items: [...items.values()], total: first.total };
}

export function selectIncrementalCandidates(
  items: KkpanResource[],
  watermark?: string,
  watermarkIds: number[] = [],
  pendingIds: number[] = []
): KkpanResource[] {
  const unique = new Map<number, KkpanResource>();
  for (const item of items) {
    const previous = unique.get(item.id);
    if (!previous || compareUpdatedAt(item.updatedAt, previous.updatedAt) > 0) {
      unique.set(item.id, item);
    }
  }

  const validWatermark = isValidWatermark(watermark) ? watermark : undefined;
  const boundaryIds = new Set(watermarkIds);
  const pending = new Set(pendingIds);
  return [...unique.values()]
    .filter(
      (item) => {
        if (pending.has(item.id)) return true;
        if (!validWatermark || !item.updatedAt) return true;
        const order = compareUpdatedAt(item.updatedAt, validWatermark);
        return order > 0 || (order === 0 && !boundaryIds.has(item.id));
      }
    )
    .sort((a, b) => {
      const aPending = pending.has(a.id);
      const bPending = pending.has(b.id);
      if (aPending !== bPending) return aPending ? -1 : 1;
      const timeOrder = compareUpdatedAt(b.updatedAt, a.updatedAt);
      return timeOrder !== 0 ? timeOrder : b.id - a.id;
    });
}

// 增量同步：完整扫描当前公开目录，按更新时间排序后分批消费。
// 上游分页并非严格按 updated_at 排序，因此不能在遇到旧条目时提前 break。
export async function runIncrementalSync(
  limit = 200,
  withAvailabilityCheck = true,
  shouldContinue?: SyncContinuation,
  contentExecution: ContentHostExecutionOptions = {}
): Promise<SyncStats> {
  const startedAt = Date.now();
  const stats: SyncStats = {
    mode: "incremental",
    pulled: 0,
    imported: 0,
    skippedExisting: 0,
    unmatched: 0,
    disabled: 0,
    refreshed: 0,
    checkedTitles: 0,
    durationMs: 0,
  };

  const prevState = await getPanSyncState();
  const watermark = isValidWatermark(prevState?.last_kkpan_watermark)
    ? prevState.last_kkpan_watermark
    : undefined;
  const existing = await getExistingPanKeys();
  const boundedLimit = normalizeSyncLimit(limit, 200);
  let catalog: StablePageScan;
  try {
    if (shouldContinue && !(await shouldContinue())) {
      stats.cancelled = true;
      stats.durationMs = Date.now() - startedAt;
      return stats;
    }
    catalog = await scanStablePages(
      (page) =>
        listCloudDriveTaskPage(page, INCREMENTAL_PAGE_SIZE, contentExecution),
      INCREMENTAL_PAGE_SIZE,
      INCREMENTAL_MAX_PAGES,
      shouldContinue
    );
  } catch {
    if (shouldContinue && !(await shouldContinue())) {
      stats.cancelled = true;
      stats.durationMs = Date.now() - startedAt;
      return stats;
    }
    stats.sourceErrors = 1;
    stats.failed = true;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  // 任意无效更新时间都会破坏高水位语义；整轮放弃，不能只跳过该条。
  if (catalog.items.some((item) => !isValidWatermark(item.updatedAt))) {
    stats.sourceErrors = 1;
    stats.failed = true;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  // 高水位记录“稳定快照的最大 updated_at + 该时刻全部 ID”；未处理候选单独放进
  // pending。这样可以优先处理最新条目，又不会因 limit 截断丢掉较旧候选或重复请求
  // 已确认未匹配的条目。
  const candidates = selectIncrementalCandidates(
    catalog.items,
    watermark,
    prevState?.last_kkpan_watermark_ids,
    prevState?.last_kkpan_pending_ids
  );

  let matchAttempts = 0;
  const pendingIds: number[] = [];
  for (const item of candidates) {
    if (shouldContinue && !(await shouldContinue())) {
      stats.cancelled = true;
      stats.durationMs = Date.now() - startedAt;
      return stats;
    }
    const brand = brandOf(item);
    if (!brand) continue;
    stats.pulled++;

    if (existing.kkpanIds.has(item.id) || existing.urls.has(item.shareLink)) {
      stats.skippedExisting++;
      continue;
    }

    // limit 是远端豆瓣匹配请求的硬预算。已存在/不支持品牌不消耗预算；尚未尝试的
    // 候选进入 pending，下次从稳定目录中按 ID 继续处理。
    if (matchAttempts >= boundedLimit) {
      pendingIds.push(item.id);
      continue;
    }
    matchAttempts++;

    const titleCandidate = extractTitleCandidate(item.fileName);
    let matched: { doubanId: string; title: string } | null;
    try {
      matched = await matchContentForTitle(
        titleCandidate,
        extractYear(item.fileName),
        contentExecution
      );
    } catch {
      if (shouldContinue && !(await shouldContinue())) {
        stats.cancelled = true;
        stats.durationMs = Date.now() - startedAt;
        return stats;
      }
      stats.doubanErrors = (stats.doubanErrors || 0) + 1;
      stats.failed = true;
      break;
    }
    if (!matched) {
      stats.unmatched++;
      continue;
    }

    const created = await importKkpanItem(item, matched.doubanId, matched.title);
    existing.kkpanIds.add(item.id);
    existing.urls.add(item.shareLink);
    if (created) stats.imported++;
    else stats.skippedExisting++;
  }

  if (stats.failed) {
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  let nextWatermark = watermark;
  let nextWatermarkIds = prevState?.last_kkpan_watermark_ids || [];
  if (catalog.items.length > 0) {
    const snapshotMax = catalog.items.reduce((max, item) =>
      compareUpdatedAt(item.updatedAt, max) > 0 ? item.updatedAt : max
    , catalog.items[0].updatedAt);
    const order = nextWatermark
      ? compareUpdatedAt(snapshotMax, nextWatermark)
      : 1;
    if (order > 0) {
      nextWatermark = snapshotMax;
      nextWatermarkIds = catalog.items
        .filter((item) => compareUpdatedAt(item.updatedAt, snapshotMax) === 0)
        .map((item) => item.id);
    } else if (order === 0) {
      nextWatermarkIds = [
        ...new Set([
          ...nextWatermarkIds,
          ...catalog.items
            .filter((item) => compareUpdatedAt(item.updatedAt, snapshotMax) === 0)
            .map((item) => item.id),
        ]),
      ];
    }
  }

  let availabilityCursor: string | undefined;
  if (withAvailabilityCheck) {
    const availability = await runAvailabilityPass(
      30,
      prevState?.last_availability_cursor,
      shouldContinue,
      contentExecution
    );
    if (availability.cancelled) {
      stats.cancelled = true;
      stats.durationMs = Date.now() - startedAt;
      return stats;
    }
    stats.disabled = availability.disabled;
    stats.refreshed = availability.refreshed;
    stats.checkedTitles = availability.checkedTitles;
    if (availability.errors > 0) {
      stats.sourceErrors = (stats.sourceErrors || 0) + availability.errors;
    }
    availabilityCursor = availability.nextCursor;
    if (availability.errors > 0 && availability.checkedTitles === 0) {
      stats.failed = true;
      stats.durationMs = Date.now() - startedAt;
      return stats;
    }
  }

  if (shouldContinue && !(await shouldContinue())) {
    stats.cancelled = true;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  stats.durationMs = Date.now() - startedAt;
  const statePatch: Parameters<typeof savePanSyncState>[0] = {
    last_incremental_at: new Date().toISOString(),
    last_stats: stats as unknown as Record<string, unknown>,
  };
  if (nextWatermark) statePatch.last_kkpan_watermark = nextWatermark;
  statePatch.last_kkpan_watermark_ids = nextWatermarkIds;
  statePatch.last_kkpan_pending_ids = pendingIds;
  if (availabilityCursor) statePatch.last_availability_cursor = availabilityCursor;
  await savePanSyncState(statePatch);
  return stats;
}

// 批量补库：豆瓣热榜影片逐片搜索 kkpans，严格片名匹配入库
export async function runBackfillSync(
  limit = 100,
  contentExecution: ContentHostExecutionOptions = {}
): Promise<SyncStats> {
  const startedAt = Date.now();
  const stats: SyncStats = {
    mode: "backfill",
    pulled: 0,
    imported: 0,
    skippedExisting: 0,
    unmatched: 0,
    disabled: 0,
    refreshed: 0,
    checkedTitles: 0,
    durationMs: 0,
  };

  // 翻页拉豆瓣热榜直到累计达到 limit 或分类无新结果，让 100/200 上限生效。
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), 200)
    : 100;
  const seen = new Set<string>();
  const subjects: Array<{ id: string; title: string }> = [];
  const categories: Array<"hot_movies" | "hot_tv"> = ["hot_movies", "hot_tv"];
  const categoryPageLimit = 20;
  let categoryErrors = 0;

  for (const category of categories) {
    if (subjects.length >= boundedLimit) break;
    let cursor: string | undefined;
    let emptyRounds = 0;
    const cursors = new Set<string>();
    let page = 1;
    while (
      subjects.length < boundedLimit &&
      page <= 10 && // 单分类最多翻 10 页（200 条），避免无限拉取
      emptyRounds < 1
    ) {
      let resp;
      try {
        resp = await getContentCatalog(
          {
            view: "category",
            key: category,
            cursor,
            limit: categoryPageLimit,
          },
          contentExecution
        );
      } catch {
        categoryErrors++;
        break; // 分类接口失败跳过本分类（记入错误统计）
      }
      const mapped = resp.items.map(getLegacyDoubanCandidate);
      const incompatible = resp.items.some(
        (item, index) => !mapped[index] && item.externalRefs.length > 0
      );
      if (incompatible) categoryErrors++;
      const subs = mapped
        .filter((value): value is NonNullable<typeof value> => value !== null)
        .map((value) => ({ id: value.doubanId, title: value.title }));
      if (subs.length === 0) {
        emptyRounds++;
        break;
      }
      let added = 0;
      for (const subject of subs) {
        if (!subject?.id || seen.has(subject.id)) continue;
        seen.add(subject.id);
        subjects.push(subject);
        added++;
        if (subjects.length >= boundedLimit) break;
      }
      if (added === 0) break; // 整页都是已见过的，停止翻页
      if (!resp.hasMore) break;
      if (!resp.nextCursor || cursors.has(resp.nextCursor)) {
        categoryErrors++;
        break;
      }
      cursors.add(resp.nextCursor);
      cursor = resp.nextCursor;
      page++;
    }
  }

  // 关键修复（QA P2-D）：若所有豆瓣分类都失败，subjects 为空，
  // 不应继续走"同步完成"流程并写入 last_backfill_at —— 那会把上游全故障
  // 显示成成功。直接返回 failed=true，由路由层返回 502，且不更新 last_backfill_at。
  if (subjects.length === 0 && categoryErrors > 0) {
    stats.durationMs = Date.now() - startedAt;
    stats.categoryErrors = categoryErrors;
    stats.failed = true;
    return stats;
  }

  const bounded = subjects.slice(0, boundedLimit);
  const existing = await getExistingPanKeys();
  let searchErrors = 0;
  let searchAttempts = 0;

  for (const subject of bounded) {
    let items: KkpanResource[] = [];
    try {
      items = (
        await searchCloudDriveTaskPage(subject.title, 20, 1, contentExecution)
      ).items;
      searchAttempts++;
    } catch {
      searchErrors++;
      continue; // 单片搜索失败不阻断整体（计入错误统计）
    }

    for (const item of items) {
      if (!brandOf(item)) continue;
      stats.pulled++;

      if (existing.kkpanIds.has(item.id) || existing.urls.has(item.shareLink)) {
        stats.skippedExisting++;
        continue;
      }

      // 严格匹配：归一化等值优先，否则用收紧后的宽松匹配（较短串 ≥3 字
      // 且长度 ≥ 另一方一半）。豆瓣列表项无年份字段，故此处不做年份容差。
      // 资源文件名通常还包含年份、集数和画质等元数据；先提取片名，
      // 再做严格匹配，避免这些后缀把真实片名判成不匹配。
      const cleaned = extractTitleCandidate(item.fileName);
      if (!titlesStrictlyMatch(cleaned, subject.title)) {
        stats.unmatched++;
        continue;
      }

      const created = await importKkpanItem(item, subject.id, subject.title);
      existing.kkpanIds.add(item.id);
      existing.urls.add(item.shareLink);
      if (created) stats.imported++;
      else stats.skippedExisting++;
    }
  }

  // 收尾错误统计与失败判定（QA P2-D）：
  //   - 所有分类失败 + 收集到 0 个 subject 的极端情形已在上方早退处理。
  //   - 这里处理"拿到了 subjects，但每片 kkpan 搜索都失败"的情况：
  //     没有任何成功响应时认定为整体失败，避免显示成"同步完成"。
  stats.categoryErrors = categoryErrors;
  stats.searchErrors = searchErrors;
  const allSearchesFailed =
    bounded.length > 0 && searchAttempts === 0 && searchErrors > 0;
  if (allSearchesFailed) stats.failed = true;

  stats.durationMs = Date.now() - startedAt;
  // 仅在认定成功时写入 last_backfill_at，否则保留上一次成功时间不被污染。
  if (!stats.failed) {
    await savePanSyncState({
      last_backfill_at: new Date().toISOString(),
      last_stats: stats as unknown as Record<string, unknown>,
    });
  }
  return stats;
}

// 失效检测：kkpan 来源的资源按片名分页回查，按 kkpan_id 比对：
//   - kkpan_id 仍在 live 集合 → 有效；若 url 已换新则更新为新 url（而非禁用）
//   - kkpan_id 不在 live 集合、但该片搜索有结果 → 判失效禁用
//   - 该片搜索无结果 → 不判死（可能只是搜索词偏差）
//   - 资源无 kkpan_id（手工录入） → 不参与失效检测
// 这样修复"换新 URL 被误禁 + 新 URL 不入库"和"前 50 名之外的链接被误禁"。
async function runAvailabilityPass(
  maxTitles = 30,
  cursor?: string,
  shouldContinue?: SyncContinuation,
  cloudDriveExecution: ContentHostExecutionOptions = {}
): Promise<{
  disabled: number;
  refreshed: number;
  checkedTitles: number;
  errors: number;
  nextCursor?: string;
  cancelled?: boolean;
}> {
  // 读取全部 kkpan 资源，片名分组后用持久化游标轮转；固定取最近 300 条会让
  // 旧片名永久得不到检查。已禁用资源也必须参与，源恢复时才能重新启用。
  const resources = await getKkpanSourceResources();
  const linked = resources.filter(
    (r) =>
      r.movie_title &&
      Number.isSafeInteger(r.kkpan_id) &&
      (r.kkpan_id as number) > 0
  );

  // 按片名稳定排序并轮转，保证每个片名最终都会被检查。
  const groups = new Map<string, typeof linked>();
  for (const resource of linked) {
    const key = resource.movie_title as string;
    const group = groups.get(key) || [];
    group.push(resource);
    groups.set(key, group);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const startIndex = cursor
    ? sortedGroups.findIndex(([title]) => title.localeCompare(cursor) > 0)
    : 0;
  const normalizedStart =
    startIndex === -1 || sortedGroups.length === 0 ? 0 : startIndex;
  const groupCount = Math.min(
    Math.max(Math.floor(maxTitles), 1),
    sortedGroups.length
  );
  const boundedGroups = Array.from({ length: groupCount }, (_, offset) =>
    sortedGroups[(normalizedStart + offset) % sortedGroups.length]
  );
  let disabled = 0;
  let refreshed = 0;
  let checkedTitles = 0;
  let errors = 0;
  let nextCursor = cursor;
  const pageSize = 50;
  const maxPages = 200; // 无 total 元数据时的保守上限

  for (const [title, group] of boundedGroups) {
    if (shouldContinue && !(await shouldContinue())) return { disabled, refreshed, checkedTitles, errors, nextCursor, cancelled: true };
    // 分页拉取该片 live 资源。扫描前后快照不一致时终止本轮，不能禁用资源或
    // 把游标推进到这个片名之后。
    const liveById = new Map<number, KkpanResource>();
    let hadAny = false;
    try {
      const scan = await scanStablePages(
        (page) =>
          searchCloudDriveTaskPage(title, pageSize, page, cloudDriveExecution),
        pageSize,
        maxPages,
        shouldContinue
      );
      const matchingItems = scan.items.filter((item) =>
        titlesStrictlyMatch(extractTitleCandidate(item.fileName), title)
      );
      // 对“缺失/存在”判断优先信任全局唯一 kkpan_id：资源改名后标题提取可能不再
      // 命中，但同 ID 仍明确表示它已恢复。没有已知 ID 命中时，才用严格标题结果
      // 作为“搜索有结果”的依据，避免相似片名触发误禁。
      const groupIds = new Set(group.map((resource) => resource.kkpan_id));
      for (const item of scan.items) {
        if (groupIds.has(item.id)) liveById.set(item.id, item);
      }
      hadAny = matchingItems.length > 0 || liveById.size > 0;
    } catch {
      if (shouldContinue && !(await shouldContinue())) {
        return { disabled, refreshed, checkedTitles, errors, nextCursor, cancelled: true };
      }
      errors++;
      break;
    }
    if (!hadAny) {
      nextCursor = title;
      continue; // 搜不到严格匹配结果不判死，但本片已稳定检查，可继续轮转
    }
    checkedTitles++;

    for (const resource of group) {
      if (shouldContinue && !(await shouldContinue())) return { disabled, refreshed, checkedTitles, errors, nextCursor, cancelled: true };
      const kkpanId = resource.kkpan_id as number;
      const live = liveById.get(kkpanId);
      if (live) {
        // 仍在目录里：若 url / 提取码换新，或此前被禁用，一起恢复。
        const urlChanged = live.shareLink !== resource.url;
        const liveCode = live.shareCode?.trim().toUpperCase() || null;
        const storedCode = resource.code?.trim().toUpperCase() || null;
        const codeChanged = liveCode !== storedCode;
        const enabledChanged = !resource.enabled;
        if (urlChanged || codeChanged || enabledChanged) {
          const update: {
            url?: string;
            code?: string;
            clear_code?: boolean;
            enabled: boolean;
          } = {
            enabled: true,
          };
          if (urlChanged && live.shareLink) update.url = live.shareLink;
          if (codeChanged) {
            if (liveCode != null) update.code = liveCode;
            else update.clear_code = true;
          }
          const updated = await updatePanResourceInDB(resource.id, update);
          if (updated) refreshed++;
        }
      } else if (resource.enabled) {
        // scanStablePages 已确认完整、稳定；只对当前启用的缺失资源执行禁用。
        const updated = await updatePanResourceInDB(resource.id, {
          enabled: false,
        });
        if (updated) disabled++;
      }
    }
    nextCursor = title;
  }

  return { disabled, refreshed, checkedTitles, errors, nextCursor };
}
