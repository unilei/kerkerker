/**
 * duanjugou.top 抓取器（Z-BlogPHP 站点，纯 HTML 解析，零第三方依赖）
 *
 * 页面结构（2026-08 实测）：
 *   - 列表页：/  与 /page_N.html，条目为 <article class="post-item-row">
 *     内含 /数字.html 详情链接与标题；每页 30 条，最大页码见分页锚点。
 *   - 详情页：/数字.html，<h1 class="post-title"> 标题、JSON-LD datePublished、
 *     <div class="pan-links-list"> 网盘链接（pan-name 文案对应品牌）。
 *   - 首页 quick-tags-section 提供标签分组（搜索词即标签）。
 *
 * 抓取策略与合规：只 GET 公开页面、带常规 UA、请求间隔 ≥1s、
 * 单次任务页数有上限；解析失败跳过该条而不中断整轮。
 */

import type { ShortDramaSource } from "@/types/short-drama";

const DEFAULT_BASE_URL = "https://duanjugou.top";
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const DUANJUGOU_SOURCE: ShortDramaSource = "duanjugou";

export interface ScrapeListItem {
  article_id: string;
  title: string;
}

export interface ScrapeDetail {
  article_id: string;
  title: string;
  publish_date?: string;
  pan_links: Array<{ brand: string; url: string }>;
}

export interface ScrapeTagGroups {
  groups: Array<{ category: string; tags: string[] }>;
}

export class DuanjugouFetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DuanjugouFetchError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// HTML 基础工具（无 DOM 依赖，正则按实测结构匹配，宽松容忍属性顺序变化）
// ---------------------------------------------------------------------------

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code))
    );
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "zh-CN,zh;q=0.9",
    },
  });
  if (!response.ok) {
    throw new DuanjugouFetchError(
      `duanjugou 请求失败: HTTP ${response.status}`,
      response.status
    );
  }
  return response.text();
}

/** 从完整 HTML 中提取文章数字 ID 列表（保序去重） */
export function extractArticleIds(html: string): ScrapeListItem[] {
  const items: ScrapeListItem[] = [];
  const seen = new Set<string>();
  const pattern =
    /<article[^>]*class="[^"]*post-item-row[^"]*"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]+href="https?:\/\/[^"]*?\/(\d+)\.html"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(pattern)) {
    const articleId = match[1];
    // title 属性可能含 <strong> 搜索高亮标记，正文文本兜底；两者都清洗
    const title = stripTags(match[2]) || stripTags(match[3]);
    if (!articleId || seen.has(articleId) || !title) continue;
    seen.add(articleId);
    items.push({ article_id: articleId, title });
  }
  return items;
}

export function extractMaxPageNumber(html: string): number {
  let max = 1;
  for (const match of html.matchAll(/page_(\d+)\.html/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** 详情页解析：标题 / 发布日期 / 网盘链接 */
export function parseDetailPage(
  html: string,
  articleId: string
): ScrapeDetail | null {
  const titleMatch = html.match(
    /<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/
  );
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  if (!title) return null;

  const panLinks: Array<{ brand: string; url: string }> = [];
  const listMatch = html.match(
    /<div class="pan-links-list">([\s\S]*?)<\/div>/
  );
  if (listMatch) {
    for (const anchor of listMatch[1].matchAll(
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<span class="pan-name">([\s\S]*?)<\/span>/g
    )) {
      const url = stripTags(anchor[1]);
      const brand = stripTags(anchor[2]);
      if (url && /^https?:\/\//.test(url)) {
        panLinks.push({ brand, url });
      }
    }
  }

  // JSON-LD datePublished（缺失容忍）
  let publishDate: string | undefined;
  const ldMatch = html.match(
    /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/
  );
  if (ldMatch) publishDate = ldMatch[1];

  return { article_id: articleId, title, publish_date: publishDate, pan_links: panLinks };
}

/** 首页标签分组（搜索词即标签） */
export function parseTagGroups(html: string): ScrapeTagGroups {
  const groups: Array<{ category: string; tags: string[] }> = [];
  for (const groupMatch of html.matchAll(
    /<span class="tag-category">([^<]+)<\/span>([\s\S]*?)(?=<span class="tag-category">|<\/div>)/g
  )) {
    const category = stripTags(groupMatch[1]).replace(/[：:]$/, "");
    const tags = [...groupMatch[2].matchAll(/class="tag-item"[^>]*>([^<]+)<\/a>/g)]
      .map((tagMatch) => stripTags(tagMatch[1]))
      .filter(Boolean);
    if (category && tags.length > 0) groups.push({ category, tags });
  }
  return { groups };
}

// ---------------------------------------------------------------------------
// 站点访问封装
// ---------------------------------------------------------------------------

function baseUrl(): string {
  const raw = process.env.DUANJUGOU_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** 抓取一页列表（page=1 即首页） */
export async function scrapeListPage(page: number): Promise<{
  items: ScrapeListItem[];
  maxPage: number;
}> {
  const html = await fetchPage(
    page === 1 ? `${baseUrl()}/` : `${baseUrl()}/page_${page}.html`
  );
  return {
    items: extractArticleIds(html),
    maxPage: extractMaxPageNumber(html),
  };
}

/** 抓取详情页 */
export async function scrapeDetail(articleId: string): Promise<ScrapeDetail | null> {
  const html = await fetchPage(`${baseUrl()}/${articleId}.html`);
  return parseDetailPage(html, articleId);
}

/** 抓取搜索结果（标签词即搜索词）；搜索页每页约 100 条 */
export async function scrapeSearch(keyword: string, page = 1): Promise<{
  items: ScrapeListItem[];
}> {
  const url = `${baseUrl()}/search.php?q=${encodeURIComponent(keyword)}${
    page > 1 ? `&page=${page}` : ""
  }`;
  const html = await fetchPage(url);
  return { items: extractArticleIds(html) };
}

/** 抓取标签体系（供前台标签云兜底——本地库没有时用） */
export async function scrapeTagGroups(): Promise<ScrapeTagGroups> {
  const html = await fetchPage(`${baseUrl()}/`);
  return parseTagGroups(html);
}

// ---------------------------------------------------------------------------
// 标题解析：剧名 / 集数
// ---------------------------------------------------------------------------

/**
 * 从源站标题解析剧名与集数。
 * 实测形态：《曲曲爆火，百万粉丝却求我别写了（98 集）AI短剧》、
 * 《请旨和离，转身嫁给战神王爷（91集）》、《镇国驸马爷3D版第五季（252集）》。
 * 容忍全角/半角括号与「集」前后空格；解析不出集数时原样返回。
 */
export function parseDramaTitle(rawTitle: string): {
  title: string;
  episode_count?: number;
} {
  let title = rawTitle.trim();
  const patterns = [
    /[（(]\s*(\d{1,4})\s*集\s*[）)]\s*(?:AI短剧)?\s*$/,
    /[（(]\s*(\d{1,4})\s*集\s*[）)]/,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const episodeCount = Number(match[1]);
      title = title.replace(pattern, "").trim();
      return {
        title,
        episode_count:
          Number.isSafeInteger(episodeCount) && episodeCount > 0
            ? episodeCount
            : undefined,
      };
    }
  }
  return { title };
}
