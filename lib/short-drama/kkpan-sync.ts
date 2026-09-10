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
 * 剧名前缀里的源站序号（wogg 类源的「178.剧名」「a239.剧名」形态）不是
 * 剧名的一部分，剥掉避免卡片显示序号且保证同名剧跨行归一；要求可选
 * 单字母 + 数字 + 紧跟分隔符（.、．、）才剥，纯数字开头的剧名（如
 * 「2024爱情故事」）不受影响。
 */
export function stripSerialPrefix(title: string): string {
  return title.replace(/^\s*[a-z]?\d{1,5}\s*[.、．]\s*/i, "").trim();
}

/** 从标题提取集数（更新至/全/共/括号/（集119）/（集）19 等形态） */
export function extractEpisodeCount(title: string): number | undefined {
  const patterns = [
    /(?:更新至|更至|已更|连载至|更新到|更新)\s*第?\s*(\d{1,4})\s*(?:集|话|期)/i,
    /(?:全|共)\s*(\d{1,4})\s*(?:集|话|期)/i,
    /[（(【\[]\s*(?:全|共|更新至|更至)?\s*第?\s*(\d{1,4})\s*(?:集|话|期)\s*[)）】\]]/i,
    /(?:^|[^\d])(\d{1,4})\s*(?:集|话|期)(?:全|完结)?/i,
    // 源站数据残缺形态：「（集119）」「（集）19」（集字在数字前）
    /[（(【\[]\s*集\s*(\d{1,4})\s*[)）】\]]/i,
    /[（(【\[]\s*集\s*[)）】\]]\s*(\d{1,4})\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (!match) continue;
    const count = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(count) && count > 0) return count;
  }
  return undefined;
}

/**
 * 剥标题噪声（kkpan 实测数据，展示与归一前的公共清洗步）：
 *  - 「标题：16.」来源标注前缀
 *  - 尾缀清晰度标记（（1080P）/（4K）等）与空括号
 *  - 尾缀演员名单（空格分隔、含 &/＆ 连接的段，可叠多层）
 *  - 拆字竖线（「少｜爷」→「少爷」，规避审核的写法）
 *  - 下划线副标题分隔（「步步倾心_小侯爷专宠郡主」→ 空格）
 */
export function stripTitleNoise(title: string): string {
  let out = title
    .replace(/^标题\s*[：:]\s*(?:\d{1,4}\s*[.、．]\s*)?/, "")
    .replace(/[｜|]/g, "")
    // & 两侧空格归一：「王晨鹏 &贾翼瑄」→「…王晨鹏&贾翼瑄」，让演员段
    // 识别（下一循环）稳定；若不是演员段则展示为紧凑的 A&B
    .replace(/\s*[＆&]\s*/g, "&");
  for (let i = 0; i < 3; i += 1) {
    const next = out
      // 清晰度标记（（1080P）/（4K））及其注记形态（（1080P.高码））
      .replace(/\s*[（(]\s*\d{3,4}\s*[Pp][^）)]{0,12}[）)]\s*$/, "")
      .replace(/\s*[（(]\s*[48]\s*[Kk]\s*[）)]\s*$/, "")
      // 版本修饰尾缀（（铂金珍藏版）/（完整版）等）
      .replace(
        /\s*[（(][^）)]*(?:珍藏版|完整版|高清版|无水印|蓝光|原盘|修复版)[^）)]*[)）]\s*$/,
        ""
      )
      .replace(/\s*[（(]\s*[）)]\s*$/, "");
    if (next === out) break;
    out = next;
  }
  for (let i = 0; i < 3; i += 1) {
    // 起始边界容忍空格/右括号——演员名单常紧跟在集数括号后：
    // 「剧名（87集）张瀚文＆周颖＆蒋潇林」。保留边界字符，只剥演员段
    const next = out.replace(
      /(?:\s|[)）】\]])\S{1,24}(?:[＆&]\S{1,20})+$/u,
      (match) => match.slice(0, 1)
    );
    if (next === out) break;
    out = next;
  }
  return out.replace(/_/g, " ");
}

/** 剥集数/连载标记与 AI短剧/AI版 后缀，得到展示用剧名 */
export function stripEpisodeMarkers(title: string): string {
  return title
    // 括号形态优先剥：裸形式若先跑会把括号内文字吃掉、留下「（ ）」空壳
    .replace(
      /[（(【\[]\s*(?:全|共|更新至|更至)?\s*第?\s*\d{1,4}\s*(?:集|话|期)(?:全|完结)?\s*[)）】\]]/gi,
      " "
    )
    .replace(/[（(【\[]\s*集\s*\d{1,4}\s*[)）】\]]/gi, " ")
    .replace(/[（(【\[]\s*集\s*[)）】\]]\s*\d{1,4}\s*$/gi, " ")
    .replace(/(?:更新至|更至|已更|连载至|更新到|更新)\s*第?\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/(?:全|共)\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/第\s*\d{1,4}\s*(?:集|话|期)/gi, " ")
    .replace(/(^|[^\d])\d{1,4}\s*(?:集|话|期)(?:全|完结)?/gi, "$1 ")
    .replace(/\s*(?:完结|已完结|全集)\s*$/g, " ")
    .replace(/\s*AI\s*(?:真人)?版\s*$/gi, " ")
    .replace(/\s*AI\s*短剧\s*$/gi, " ")
    // 兜底：内层文字被剥掉后残留的空括号壳（「苏忆穿书…（更至177集）」）
    .replace(/\s*[（(【\[]\s*[)）】\]]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 展示用剧名：噪声剥离 + 集数/连载标记剥离交替进行——标记剥除后可能
 * 暴露出新的尾缀（演员/清晰度被集数括号隔开时），两遍各司其职。
 * parseKkpanResourceRow 与 content_key 归一的公共入口——清洗规则改
 * 这里，键随展示同步归一。
 */
export function formatDisplayTitle(rawTitle: string): string {
  const firstPass = stripEpisodeMarkers(stripTitleNoise(rawTitle));
  return stripEpisodeMarkers(stripTitleNoise(firstPass));
}

/**
 * 归一化剧名键：非文字/数字串折叠为空格、小写。入参应是 formatDisplayTitle
 * 的产出（内部模式保留为幂等兜底，供直接传原始标题的调用方）。
 */
export function buildContentKey(title: string): string {
  return title
    .replace(/\s*AI\s*(?:真人)?[版短剧]*\s*$/gi, " ")
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
  const title = formatDisplayTitle(stripped);
  const contentKey = buildContentKey(title);
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
