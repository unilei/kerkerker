import {
  upsertShortDramasFromKkpan,
  markShortDramasOfflineNotInContentKeys,
  updateShortDramaSyncState,
} from "@/lib/short-drama-db";
import type { ShortDramaUpsertInput } from "@/types/short-drama";
import { queuePublishedDramaUrl, flushQueuedDramaUrls } from "@/lib/seo-push";

/**
 * 短剧条目同步：kkpan 公开 API → 本地 MongoDB。
 *
 * 数据源：kkpan 公开资源列表（免鉴权）——
 *   GET {KKPAN_API_BASE_URL}/api/resources/public
 *       ?category_slug=short-drama&platform=quark&limit=100&page=N
 * 服务端已保证 status='shared'（存在 completed 的 catalog 转存任务），
 * platform=quark 过滤转存目标平台；kkpan 侧已删除的死链不会出现。
 * 返回字段：id / file_name / description / share_link（kkpan 自有分享
 * 链接）/ share_code / updated_at（公开口径的最新时间）。
 *
 * 同一剧名在 kkpan 可能有多行（不同集数进度/来源），按归一化剧名键
 * （content_key）聚合，保留集数最大（同则最近更新）的一行入库；
 * 每轮全量拉取并收敛：kkpan 已消失的条目置 offline（重新出现即恢复）。
 * 同步是快速同步请求（分页并发拉取 + 批量写），不需要任务租约。
 */

export interface EntriesSyncStats {
  /** kkpan API 取到的资源行数（聚合前） */
  fetched: number;
  created: number;
  updated: number;
  /** 同剧多行被合并掉的行数 */
  collapsed: number;
  /** 无有效夸克分享链接被跳过的行数 */
  skipped_no_share: number;
  /** 本轮置 offline 的本地条目数 */
  offline_marked: number;
  failed: boolean;
  error?: string;
}

export function isKkpanApiConfigured(): boolean {
  return Boolean(process.env.KKPAN_API_BASE_URL?.trim());
}

function kkpanApiBase(): string {
  const raw = process.env.KKPAN_API_BASE_URL?.trim();
  if (!raw) throw new Error("KKPAN_API_BASE_URL 环境变量未设置");
  return raw.replace(/\/+$/, "");
}

export interface KkpanApiRow {
  id: number | string;
  file_name: string;
  description?: string | null;
  share_link?: string | null;
  share_code?: string | null;
  updated_at?: string;
}

async function fetchKkpanPage(page: number, limit: number): Promise<{ rows: KkpanApiRow[]; total: number }> {
  const params = new URLSearchParams({
    category_slug: "short-drama",
    platform: "quark",
    page: String(page),
    limit: String(limit),
  });
  const response = await fetch(`${kkpanApiBase()}/api/resources/public?${params}`, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`kkpan API 请求失败: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: unknown;
    total?: unknown;
  };
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("kkpan API 响应格式异常（缺 data 数组）");
  }
  return {
    rows: payload.data as KkpanApiRow[],
    total: Number(payload.total) || 0,
  };
}

/**
 * 拉取 kkpan 短剧（quark）全部公开资源行：首页探总量，其余页按 5 页
 * 一组并发拉取（kkpan limit 上限 100/页，几千行约几十次请求）。
 */
export async function fetchAllKkpanShortDramaRows(): Promise<KkpanApiRow[]> {
  const PAGE_SIZE = 100;
  const CONCURRENCY = 5;
  const first = await fetchKkpanPage(1, PAGE_SIZE);
  const rows = [...first.rows];
  const totalPages = Math.max(1, Math.ceil(first.total / PAGE_SIZE));
  for (let start = 2; start <= totalPages; start += CONCURRENCY) {
    const pages = Array.from(
      { length: Math.min(CONCURRENCY, totalPages - start + 1) },
      (_, index) => start + index
    );
    const results = await Promise.all(
      pages.map((page) => fetchKkpanPage(page, PAGE_SIZE))
    );
    for (const result of results) rows.push(...result.rows);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 标题/集数解析（纯函数，供单测）。归一化口径移植自 kkpan
// series-update-alert.service 的 extractEpisodeCount/buildContentKey，
// 保证两侧对「同一部剧」的判定一致。
// ---------------------------------------------------------------------------

/** 剥尾部网盘平台标签：`剧名 [夸克网盘]` → `剧名` */
export function stripPlatformSuffix(fileName: string): string {
  return fileName
    .replace(
      /\s*\[[^\]]*(?:网盘|云盘|quark|baidu|guangya|xunlei|uc|夸克|百度|光鸭|迅雷)[^\]]*\]\s*$/i,
      ""
    )
    .trim();
}

/**
 * 剧名前缀里的源站序号（wogg 类源的「178.剧名」形态）不是剧名的一部分，
 * 剥掉避免卡片显示「178.」且保证同名剧跨行归一；要求紧跟分隔符（.、．、）
 * 才剥，纯数字开头的剧名（如「2024爱情故事」）不受影响。
 */
export function stripSerialPrefix(title: string): string {
  return title.replace(/^\s*\d{1,5}\s*[.、．]\s*/, "").trim();
}

/** 从标题提取集数（更新至/全/共/括号/N集 等形态） */
export function extractEpisodeCount(title: string): number | undefined {
  const patterns = [
    /(?:更新至|更至|已更|连载至|更新到|更新)\s*第?\s*(\d{1,4})\s*(?:集|话|期)/i,
    /(?:全|共)\s*(\d{1,4})\s*(?:集|话|期)/i,
    /[（(【\[]\s*(?:全|共|更新至|更至)?\s*第?\s*(\d{1,4})\s*(?:集|话|期)\s*[)）】\]]/i,
    /(?:^|[^\d])(\d{1,4})\s*(?:集|话|期)(?:全|完结)?/i,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (!match) continue;
    const count = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(count) && count > 0) return count;
  }
  return undefined;
}

/** 剥集数/连载标记与 AI短剧 后缀，得到展示用剧名 */
export function stripEpisodeMarkers(title: string): string {
  return title
    .replace(/(?:更新至|更至|已更|连载至|更新到|更新)\s*第?\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/(?:全|共)\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/[（(【\[]\s*(?:全|共|更新至|更至)?\s*第?\s*\d{1,4}\s*(?:集|话|期)\s*[)）】\]]/gi, " ")
    .replace(/第\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/(^|[^\d])\d{1,4}\s*(?:集|话|期)(?:全|完结)?/gi, "$1 ")
    .replace(/\s*(?:完结|已完结|全集)\s*$/g, " ")
    .replace(/\s*AI\s*短剧\s*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 归一化剧名键：非文字/数字串折叠为空格、小写（同一部剧的稳定身份） */
export function buildContentKey(title: string): string {
  return title
    .replace(/\s*AI\s*短剧\s*$/gi, " ")
    .replace(/(?:更新至|更至|已更|连载至|更新到|更新)\s*第?\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/(?:全|共)\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/[（(【\[]\s*(?:全|共|更新至|更至)?\s*第?\s*\d{1,4}\s*(?:集|话|期)\s*[)）】\]]/gi, " ")
    .replace(/第\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/(^|[^\d])\d{1,4}\s*(?:集|话|期)(?:全|完结)?/gi, "$1 ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface ParsedKkpanResource {
  resourceId: string;
  contentKey: string;
  title: string;
  episodeCount?: number;
  shareUrl: string;
  shareCode?: string;
  description?: string;
  publicUpdatedAt: string;
}

/** 解析单行 kkpan API 资源；无有效夸克分享链接/空标题时返回 null */
export function parseKkpanResourceRow(row: KkpanApiRow): ParsedKkpanResource | null {
  const shareUrl = (row.share_link || "").trim();
  if (!/^https?:\/\/pan\.quark\.cn\//i.test(shareUrl)) return null;

  const stripped = stripSerialPrefix(stripPlatformSuffix(row.file_name || ""));
  if (!stripped) return null;
  const episodeCount = extractEpisodeCount(stripped);
  const title = stripEpisodeMarkers(stripped);
  const contentKey = buildContentKey(stripped);
  if (!title || !contentKey) return null;

  const updatedAtMs = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
  if (!Number.isFinite(updatedAtMs)) return null;
  const updatedAt = new Date(updatedAtMs).toISOString();

  return {
    resourceId: String(row.id),
    contentKey,
    title,
    ...(episodeCount !== undefined ? { episodeCount } : {}),
    shareUrl,
    ...(row.share_code ? { shareCode: row.share_code } : {}),
    ...(row.description?.trim() ? { description: row.description.trim() } : {}),
    publicUpdatedAt: updatedAt,
  };
}

/**
 * 按剧聚合：同 content_key 保留集数最大（同则 public_updated_at 最新）
 * 的一行，其余折叠。
 */
export function collapseByContentKey(
  rows: ParsedKkpanResource[]
): { kept: ParsedKkpanResource[]; collapsed: number } {
  const byKey = new Map<string, ParsedKkpanResource>();
  let collapsed = 0;
  for (const row of rows) {
    const existing = byKey.get(row.contentKey);
    if (!existing) {
      byKey.set(row.contentKey, row);
      continue;
    }
    collapsed += 1;
    const existingEp = existing.episodeCount ?? -1;
    const rowEp = row.episodeCount ?? -1;
    if (rowEp > existingEp) {
      byKey.set(row.contentKey, row);
    } else if (rowEp === existingEp && row.publicUpdatedAt > existing.publicUpdatedAt) {
      byKey.set(row.contentKey, row);
    }
  }
  return { kept: Array.from(byKey.values()), collapsed };
}

export async function runShortDramaEntriesSync(): Promise<EntriesSyncStats> {
  const stats: EntriesSyncStats = {
    fetched: 0,
    created: 0,
    updated: 0,
    collapsed: 0,
    skipped_no_share: 0,
    offline_marked: 0,
    failed: false,
  };

  try {
    const rows = await fetchAllKkpanShortDramaRows();
    stats.fetched = rows.length;

    const parsed: ParsedKkpanResource[] = [];
    for (const row of rows) {
      const item = parseKkpanResourceRow(row);
      if (item) parsed.push(item);
      else stats.skipped_no_share += 1;
    }

    const { kept, collapsed } = collapseByContentKey(parsed);
    stats.collapsed = collapsed;

    const inputs: ShortDramaUpsertInput[] = kept.map((item) => ({
      source: "kkpan" as const,
      source_article_id: item.resourceId,
      content_key: item.contentKey,
      title: item.title,
      ...(item.episodeCount !== undefined ? { episode_count: item.episodeCount } : {}),
      share_url: item.shareUrl,
      ...(item.shareCode ? { share_code: item.shareCode } : {}),
      ...(item.description ? { description: item.description } : {}),
      publish_date: item.publicUpdatedAt.slice(0, 10),
    }));

    const upsert = await upsertShortDramasFromKkpan(inputs);
    stats.created = upsert.created;
    stats.updated = upsert.updated;

    // 新发布的条目进搜索引擎推送缓冲，收尾统一 flush（尽力而为）
    for (const id of upsert.createdIds) {
      queuePublishedDramaUrl(id);
    }

    // 收敛下线：kkpan 已消失的条目置 offline（重新出现即恢复）
    const keys = new Set(kept.map((item) => item.contentKey));
    stats.offline_marked = await markShortDramasOfflineNotInContentKeys(keys);

    await updateShortDramaSyncState({
      last_entries_sync_at: new Date().toISOString(),
      last_entries_sync_stats: stats as unknown as Record<string, unknown>,
    });

    return stats;
  } catch (error) {
    stats.failed = true;
    stats.error = error instanceof Error ? error.message : String(error);
    return stats;
  } finally {
    await flushQueuedDramaUrls();
  }
}
