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
  listKkpanRecent,
  searchKkpanResources,
  cleanKkpanTitle,
  formatBytes,
  extractTitleCandidate,
  extractYear,
  titlesLooselyMatch,
  type KkpanResource,
} from "@/lib/kkpan";
import { searchDouban, getCategoryData, type Subject } from "@/lib/douban-service";
import {
  createPanResourceInDB,
  getExistingPanKeys,
  getKkpanSourceResources,
  updatePanResourceInDB,
  savePanSyncState,
} from "@/lib/pan-resources-db";
import { PAN_BRANDS, type PanBrand } from "@/types/pan-resource";

const FORMAT_RE = /\b(MP4|MKV|AVI|MOV|RMVB|WMV|FLV|WEBM|ISO|TS)\b/i;

export interface SyncStats {
  mode: "incremental" | "backfill";
  pulled: number; // kkpans 拉到的有效资源数
  imported: number; // 新入库
  skippedExisting: number; // 已存在跳过
  unmatched: number; // 未能匹配影片而跳过
  disabled: number; // 失效禁用
  checkedTitles: number; // 失效检测覆盖的影片数
  durationMs: number;
}

function brandOf(item: KkpanResource): PanBrand | null {
  return (PAN_BRANDS as string[]).includes(item.targetPlatform)
    ? (item.targetPlatform as PanBrand)
    : null;
}

// 入库一条 kkpan 资源（调用方保证已去重）
async function importKkpanItem(
  item: KkpanResource,
  doubanId: string,
  movieTitle: string
): Promise<void> {
  await createPanResourceInDB({
    douban_id: doubanId,
    movie_title: movieTitle,
    brand: brandOf(item) as PanBrand,
    title: cleanKkpanTitle(item.fileName),
    url: item.shareLink,
    code: item.shareCode?.toUpperCase() || undefined,
    size: formatBytes(item.fileSize),
    format: item.fileName.match(FORMAT_RE)?.[1]?.toUpperCase(),
    source: "kkpan",
    kkpan_id: item.id,
  });
}

// 资源名 → 豆瓣影片匹配（宽松包含 + 年份容差 ±1，取前 5 个候选）
async function matchDoubanForTitle(
  rawTitle: string,
  year?: string
): Promise<{ doubanId: string; title: string } | null> {
  try {
    const result = await searchDouban(rawTitle);
    const candidates = (result.suggest || []).slice(0, 5);
    for (const candidate of candidates) {
      if (!titlesLooselyMatch(candidate.title, rawTitle)) continue;
      if (year && candidate.year) {
        const diff = Math.abs(Number(candidate.year) - Number(year));
        if (Number.isFinite(diff) && diff > 1) continue;
      }
      return { doubanId: candidate.id, title: candidate.title };
    }
  } catch {
    // 豆瓣服务不可用时不阻断同步，按未匹配处理
  }
  return null;
}

// 增量同步：拉最新一页 → 去重 → 豆瓣匹配入库 → 失效检测
export async function runIncrementalSync(
  limit = 50,
  withAvailabilityCheck = true
): Promise<SyncStats> {
  const startedAt = Date.now();
  const stats: SyncStats = {
    mode: "incremental",
    pulled: 0,
    imported: 0,
    skippedExisting: 0,
    unmatched: 0,
    disabled: 0,
    checkedTitles: 0,
    durationMs: 0,
  };

  const items = await listKkpanRecent(limit);
  const existing = await getExistingPanKeys();

  for (const item of items) {
    if (!brandOf(item)) continue;
    stats.pulled++;

    if (existing.kkpanIds.has(item.id) || existing.urls.has(item.shareLink)) {
      stats.skippedExisting++;
      continue;
    }

    const titleCandidate = extractTitleCandidate(item.fileName);
    const matched = await matchDoubanForTitle(
      titleCandidate,
      extractYear(item.fileName)
    );
    if (!matched) {
      stats.unmatched++;
      continue;
    }

    await importKkpanItem(item, matched.doubanId, matched.title);
    existing.kkpanIds.add(item.id);
    existing.urls.add(item.shareLink);
    stats.imported++;
  }

  if (withAvailabilityCheck) {
    const availability = await runAvailabilityPass();
    stats.disabled = availability.disabled;
    stats.checkedTitles = availability.checkedTitles;
  }

  stats.durationMs = Date.now() - startedAt;
  await savePanSyncState({
    last_incremental_at: new Date().toISOString(),
    last_stats: stats as unknown as Record<string, unknown>,
  });
  return stats;
}

// 批量补库：豆瓣热榜影片逐片搜索 kkpans，严格片名匹配入库
export async function runBackfillSync(limit = 100): Promise<SyncStats> {
  const startedAt = Date.now();
  const stats: SyncStats = {
    mode: "backfill",
    pulled: 0,
    imported: 0,
    skippedExisting: 0,
    unmatched: 0,
    disabled: 0,
    checkedTitles: 0,
    durationMs: 0,
  };

  const [movies, tv] = await Promise.all([
    getCategoryData("hot_movies").catch(() => ({ subjects: [] as Subject[] })),
    getCategoryData("hot_tv").catch(() => ({ subjects: [] as Subject[] })),
  ]);

  const seen = new Set<string>();
  const subjects = [...(movies.subjects || []), ...(tv.subjects || [])].filter(
    (subject) => {
      if (!subject?.id || seen.has(subject.id)) return false;
      seen.add(subject.id);
      return true;
    }
  );
  const bounded = subjects.slice(0, Math.min(Math.max(limit, 1), 200));
  const existing = await getExistingPanKeys();

  for (const subject of bounded) {
    let items: KkpanResource[] = [];
    try {
      items = await searchKkpanResources(subject.title, 20);
    } catch {
      continue; // 单片搜索失败不阻断整体
    }

    for (const item of items) {
      if (!brandOf(item)) continue;
      stats.pulled++;

      if (existing.kkpanIds.has(item.id) || existing.urls.has(item.shareLink)) {
        stats.skippedExisting++;
        continue;
      }

      // 严格匹配：资源名需包含豆瓣片名（或反之）
      // （Subject 列表项无年份字段，年份校验仅增量模式做）
      const cleaned = cleanKkpanTitle(item.fileName);
      if (!titlesLooselyMatch(cleaned, subject.title)) {
        stats.unmatched++;
        continue;
      }

      await importKkpanItem(item, subject.id, subject.title);
      existing.kkpanIds.add(item.id);
      existing.urls.add(item.shareLink);
      stats.imported++;
    }
  }

  stats.durationMs = Date.now() - startedAt;
  await savePanSyncState({
    last_backfill_at: new Date().toISOString(),
    last_stats: stats as unknown as Record<string, unknown>,
  });
  return stats;
}

// 失效检测：kkpan 来源且启用的资源按片名回查，链接消失则禁用。
// 搜索无结果的影片跳过（可能只是搜索词偏差，不敢判死）。
async function runAvailabilityPass(maxTitles = 30): Promise<{
  disabled: number;
  checkedTitles: number;
}> {
  const resources = await getKkpanSourceResources(300);
  const enabled = resources.filter((r) => r.enabled && r.movie_title);

  // 按片名分组，取资源最多的前 N 组控制请求量
  const groups = new Map<string, typeof enabled>();
  for (const resource of enabled) {
    const key = resource.movie_title as string;
    const group = groups.get(key) || [];
    group.push(resource);
    groups.set(key, group);
  }
  const boundedGroups = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxTitles);

  let disabled = 0;
  let checkedTitles = 0;

  for (const [title, group] of boundedGroups) {
    let items: KkpanResource[] = [];
    try {
      items = await searchKkpanResources(title, 50);
    } catch {
      continue;
    }
    if (items.length === 0) continue; // 搜不到结果不判死
    checkedTitles++;

    const liveUrls = new Set(items.map((item) => item.shareLink));
    for (const resource of group) {
      if (!liveUrls.has(resource.url)) {
        const updated = await updatePanResourceInDB(resource.id, {
          enabled: false,
        });
        if (updated) disabled++;
      }
    }
  }

  return { disabled, checkedTitles };
}
