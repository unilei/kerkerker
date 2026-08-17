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
  listKkpanPage,
  searchKkpanResources,
  cleanKkpanTitle,
  formatBytes,
  extractTitleCandidate,
  extractYear,
  titlesStrictlyMatch,
  type KkpanResource,
} from "@/lib/kkpan";
import {
  searchDouban,
  getCategoryData,
  type Subject,
  type CategoryResponse,
} from "@/lib/douban-service";
import {
  createPanResourceInDB,
  getExistingPanKeys,
  getKkpanSourceResources,
  getMaxKkpanId,
  getPanSyncState,
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
  refreshed: number; // 失效检测中链接换新（url 更新而非禁用）
  checkedTitles: number; // 失效检测覆盖的影片数
  durationMs: number;
}

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
  movieTitle: string
): Promise<boolean> {
  const { created } = await createPanResourceInDB({
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
  return created;
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
      if (!titlesStrictlyMatch(candidate.title, rawTitle)) continue;
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

// 增量同步：按更新时间倒序翻页拉 kkpans 最新资源，命中水位游标即停；
// 每条经豆瓣搜索匹配入库，最后跑失效检测。limit 控制本次抓取上限。
export async function runIncrementalSync(
  limit = 200,
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
    refreshed: 0,
    checkedTitles: 0,
    durationMs: 0,
  };

  const existing = await getExistingPanKeys();
  // 上次同步水位：翻页过程中遇到此 kkpan_id 表示已进入旧数据区，提前停止。
  const prevState = await getPanSyncState();
  const watermark = prevState?.last_kkpan_watermark;
  let hitWatermark = false;
  let newWatermark = watermark;
  let pulled = 0;
  const pageSize = 50;
  const maxPages = Math.max(1, Math.ceil(Math.min(limit, 500) / pageSize));

  for (let page = 1; page <= maxPages && !hitWatermark && pulled < limit; page++) {
    const items = await listKkpanPage(page, pageSize);
    if (items.length === 0) break;

    for (const item of items) {
      if (pulled >= limit) break;
      // 命中水位游标：后续都是上次已处理的旧资源，停止翻页
      if (watermark != null && item.id === watermark) {
        hitWatermark = true;
        break;
      }

      pulled++;
      if (!brandOf(item)) continue;
      stats.pulled++;

      if (
        existing.kkpanIds.has(item.id) ||
        existing.urls.has(item.shareLink)
      ) {
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

      const created = await importKkpanItem(
        item,
        matched.doubanId,
        matched.title
      );
      existing.kkpanIds.add(item.id);
      existing.urls.add(item.shareLink);
      if (created) stats.imported++;
      else stats.skippedExisting++;
    }
  }

  // 记录本次同步处理的最新一条 kkpan_id 作为下次水位。
  // 用库里现有 kkpan_id 的最大值近似——比"本次最后一条"更稳，因为它
  // 反映了"截至现在已处理过的最新 kkpan 资源"，即使本次未拉满也算到位。
  const maxKkpanId = await getMaxKkpanId();
  if (maxKkpanId != null) newWatermark = maxKkpanId;

  if (withAvailabilityCheck) {
    const availability = await runAvailabilityPass();
    stats.disabled = availability.disabled;
    stats.refreshed = availability.refreshed;
    stats.checkedTitles = availability.checkedTitles;
  }

  stats.durationMs = Date.now() - startedAt;
  await savePanSyncState({
    last_incremental_at: new Date().toISOString(),
    last_stats: stats as unknown as Record<string, unknown>,
    last_kkpan_watermark: newWatermark,
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
    refreshed: 0,
    checkedTitles: 0,
    durationMs: 0,
  };

  // 翻页拉豆瓣热榜直到累计达到 limit 或分类无新结果，让 100/200 上限生效。
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const seen = new Set<string>();
  const subjects: Subject[] = [];
  const categories: Array<"hot_movies" | "hot_tv"> = ["hot_movies", "hot_tv"];
  const categoryPageLimit = 20;

  for (const category of categories) {
    if (subjects.length >= boundedLimit) break;
    let page = 1;
    let emptyRounds = 0;
    while (
      subjects.length < boundedLimit &&
      page <= 10 && // 单分类最多翻 10 页（200 条），避免无限拉取
      emptyRounds < 1
    ) {
      let resp: CategoryResponse | null = null;
      try {
        resp = await getCategoryData(category, page, categoryPageLimit);
      } catch {
        break; // 分类接口失败跳过本分类
      }
      const subs = resp.subjects || [];
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
      page++;
      if (added === 0) break; // 整页都是已见过的，停止翻页
    }
  }

  const bounded = subjects.slice(0, boundedLimit);
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

      // 严格匹配：归一化等值优先，否则用收紧后的宽松匹配（较短串 ≥3 字
      // 且长度 ≥ 另一方一半）。豆瓣列表项无年份字段，故此处不做年份容差。
      const cleaned = cleanKkpanTitle(item.fileName);
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

  stats.durationMs = Date.now() - startedAt;
  await savePanSyncState({
    last_backfill_at: new Date().toISOString(),
    last_stats: stats as unknown as Record<string, unknown>,
  });
  return stats;
}

// 失效检测：kkpan 来源且启用的资源按片名分页回查，按 kkpan_id 比对：
//   - kkpan_id 仍在 live 集合 → 有效；若 url 已换新则更新为新 url（而非禁用）
//   - kkpan_id 不在 live 集合、但该片搜索有结果 → 判失效禁用
//   - 该片搜索无结果 → 不判死（可能只是搜索词偏差）
//   - 资源无 kkpan_id（手工录入） → 不参与失效检测
// 这样修复"换新 URL 被误禁 + 新 URL 不入库"和"前 50 名之外的链接被误禁"。
async function runAvailabilityPass(maxTitles = 30): Promise<{
  disabled: number;
  refreshed: number;
  checkedTitles: number;
}> {
  const resources = await getKkpanSourceResources(300);
  const enabled = resources.filter(
    (r) => r.enabled && r.movie_title && r.kkpan_id != null
  );

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
  let refreshed = 0;
  let checkedTitles = 0;
  const pageSize = 50;
  const maxPages = 5; // 单片最多翻 5 页（250 条）覆盖换新场景

  for (const [title, group] of boundedGroups) {
    // 分页拉取该片全部 live 资源，直到无新结果或翻完上限
    const liveById = new Map<number, KkpanResource>();
    let hadAny = false;
    try {
      for (let page = 1; page <= maxPages; page++) {
        const items = await searchKkpanResources(title, pageSize, page);
        if (items.length === 0) break;
        hadAny = true;
        for (const item of items) liveById.set(item.id, item);
        if (items.length < pageSize) break; // 不足一页说明已是末页
      }
    } catch {
      continue;
    }
    if (!hadAny) continue; // 搜不到结果不判死
    checkedTitles++;

    for (const resource of group) {
      const kkpanId = resource.kkpan_id as number;
      const live = liveById.get(kkpanId);
      if (live) {
        // 仍在目录里：若 url 换新，更新为新 url 并确保启用
        if (live.shareLink && live.shareLink !== resource.url) {
          const updated = await updatePanResourceInDB(resource.id, {
            url: live.shareLink,
            enabled: true,
          });
          if (updated) refreshed++;
        }
      } else {
        // kkpan_id 已不在目录里：判失效禁用
        const updated = await updatePanResourceInDB(resource.id, {
          enabled: false,
        });
        if (updated) disabled++;
      }
    }
  }

  return { disabled, refreshed, checkedTitles };
}
