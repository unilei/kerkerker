/**
 * kkpans.com（自家网盘资源站）公开目录 API 客户端
 *
 * 只拉「转存成功」的资源：kkpans 公开目录接口在 SQL 层硬性要求
 * EXISTS(transfer_tasks.status='completed' AND publication_scope='catalog')，
 * 未转存完成的资源不会出现在结果里（拉新转存收益依赖可用的分享链接）。
 */

const KKPAN_API_BASE = process.env.KKPAN_API_BASE || "https://www.kkpans.com";

export type KkpanPlatform =
  | "quark"
  | "baidu"
  | "guangya"
  | "xunlei"
  | "uc"
  | "other";

export interface KkpanResource {
  id: number;
  fileName: string;
  description?: string | null;
  fileSize?: number | null; // 字节数
  shareLink: string;
  shareCode?: string | null;
  targetPlatform: KkpanPlatform;
  updatedAt: string;
}

// 公开接口原始行（仅取我们关心的字段）
interface KkpanPublicRow {
  id: number;
  file_name: string;
  description: string | null;
  file_size: number | null;
  share_link: string | null;
  share_code: string | null;
  target_platform: string | null;
  updated_at: string;
}

export interface KkpanPageResult {
  items: KkpanResource[];
  total?: number;
  rawCount: number;
  // 未经过 share_link 过滤的原始 ID 与页指纹，用于检测 offset 分页扫描期间的漂移。
  rawIds: number[];
  fingerprint: string;
}

function mapPublicRows(rows: KkpanPublicRow[]): KkpanResource[] {
  return rows
    .filter(
      (row) => row.share_link && /^https?:\/\//.test(row.share_link as string)
    )
    .map((row) => ({
      id: row.id,
      fileName: row.file_name || "未命名资源",
      description: row.description,
      fileSize: row.file_size,
      shareLink: row.share_link as string,
      shareCode: row.share_code,
      targetPlatform: (row.target_platform || "other") as KkpanPlatform,
      updatedAt: row.updated_at,
    }));
}

function pageTotal(payload: { total?: unknown }): number | undefined {
  return typeof payload.total === "number" &&
    Number.isSafeInteger(payload.total) &&
    payload.total >= 0
    ? payload.total
    : undefined;
}

function toPageResult(payload: {
  data?: unknown;
  total?: unknown;
}): KkpanPageResult {
  if (!Array.isArray(payload.data)) {
    throw new Error("kkpans 接口响应格式错误：data 必须是数组");
  }
  const rows = payload.data as KkpanPublicRow[];
  if (rows.some((row) => !Number.isSafeInteger(row?.id) || row.id <= 0)) {
    throw new Error("kkpans 接口响应格式错误：资源 id 必须是正安全整数");
  }
  return {
    items: mapPublicRows(rows),
    total: pageTotal(payload),
    rawCount: rows.length,
    rawIds: rows.map((row) => row.id),
    fingerprint: JSON.stringify(
      rows.map((row) => [
        row.id,
        row.file_name,
        row.updated_at,
        row.share_link,
        row.share_code,
        row.file_size,
        row.target_platform,
      ])
    ),
  };
}

// 按关键词搜索公开目录（仅转存成功资源），失败抛错由调用方处理。
// page 从 1 开始，limit 上限 50。
export async function searchKkpanResources(
  keyword: string,
  limit = 40,
  page = 1
): Promise<KkpanResource[]> {
  return (await searchKkpanResourcesWithMeta(keyword, limit, page)).items;
}

export async function searchKkpanResourcesWithMeta(
  keyword: string,
  limit = 40,
  page = 1
): Promise<KkpanPageResult> {
  const params = new URLSearchParams({
    search: keyword,
    page: String(Math.max(page, 1)),
    limit: String(Math.min(Math.max(limit, 1), 50)),
  });

  const response = await fetch(
    `${KKPAN_API_BASE}/api/resources/public?${params.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error(`kkpans 接口请求失败：HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: unknown;
    total?: unknown;
  };
  return toPageResult(payload);
}

// 清洗 kkpan 资源标题里的装饰符号：✅━━[片名][2021][4K]━━✅ → 片名 [2021][4K]
export function cleanKkpanTitle(fileName: string): string {
  const cleaned = fileName
    .replace(/[\u2705\u2714\u2713\u2728]/gu, " ") // ✅✔✓✨
    .replace(/[\u2500\u2501\u2550]{2,}/gu, " ") // ─ ━ ═ 分隔线
    .replace(/[\u2588\u2593\u25C0\u25B6\u25B2\u25BC]+/gu, " ") // ▉◀▶▲▼ 装饰块
    .replace(/[|｜]{2,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.slice(0, 100) || fileName.slice(0, 100);
}

// 字节数转人类可读大小（23085449216 → 21.5GB）
export function formatBytes(bytes?: number | null): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${units[unitIndex]}`;
}

// 拉取公开目录指定页（按更新时间倒序）。page 从 1 开始，limit 上限 50。
// 显式带 sort=latest 避免接口默认走"精选"排序导致漏拉当天更新。
// 接口无时间过滤参数，调用方会完整扫描当前目录后按更新时间水位分批消费。
export async function listKkpanPage(
  page = 1,
  limit = 50
): Promise<KkpanResource[]> {
  return (await listKkpanPageWithMeta(page, limit)).items;
}

export async function listKkpanPageWithMeta(
  page = 1,
  limit = 50
): Promise<KkpanPageResult> {
  const params = new URLSearchParams({
    page: String(Math.max(page, 1)),
    limit: String(Math.min(Math.max(limit, 1), 50)),
    sort: "latest",
  });
  const response = await fetch(
    `${KKPAN_API_BASE}/api/resources/public?${params.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    }
  );
  if (!response.ok) {
    throw new Error(`kkpans 接口请求失败：HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: unknown;
    total?: unknown;
  };
  return toPageResult(payload);
}

// 规格/音轨/字幕/集数/状态等元数据通常出现在片名之后，或以独立括号段出现在片名之前。
// 这些标记只用于截断候选，不参与标题匹配。
const META_CUT_RE = new RegExp(
  [
    "(?:^|\\s)(?:4K|8K|2K|1080[Pp]?|2160[Pp]?|720[Pp]?|60FPS|120FPS|10bit|HDR10?|DV|REMUX|DTS|H26[45]|WEB-?DL|BluRay)(?=\\b|\\s|$)",
    "(?:^|\\s)(?:内封|内嵌|官中|简中|简体|中字|双语|国语|粤语|蓝光|高清|原盘|无水印|纯净版|典藏版|未删减|高码(?:率)?|双版本|特效字幕|流媒体)",
    "(?:^|\\s)(?:更新至|更至|更\\s*\\d|附第)",
    "(?:^|\\s)(?:全\\s*[一二三四五六七八九十百两\\d]+\\s*(?:集|季|部)|第?\\s*[一二三四五六七八九十百两\\d]+\\s*季)",
    "(?:^|\\s)(?:S\\d{1,2}(?:[-_]S?\\d{1,2})?(?:E\\d{1,3})?|\\d+\\s*集)",
    "(?:^|\\s)(?:类型|主演|剧情|动作|喜剧|爱情|悬疑|科幻|犯罪|战争|青春|校园|冒险|历史)[:：]",
  ].join("|"),
  "i"
);

const BRACKET_PAIRS: Record<string, string> = {
  "【": "】",
  "[": "]",
  "［": "］",
  "《": "》",
  "「": "」",
  "『": "』",
  "(": ")",
  "（": "）",
};

// 前导装饰字符（emoji、符号块等；保留中英文、数字和标题括号）。
const LEADING_NOISE_RE = /^[^\u4e00-\u9fa5A-Za-z0-9《》【】「」『』()[\]［］]+/u;

const GENERIC_METADATA_RE =
  /^(?:电视剧|电影|剧版|美剧|日剧|韩剧|国产剧|港剧|台剧|学习资料|经典(?:儿童)?动画故事?|系列全收集|全收集|资源合集|合集|网盘)$/i;

// 从开头读取一个成对括号段。支持「《片名》」这类嵌套标题括号，避免用单个正则
// 把“【全 29 集】「片名」”错误地截成集数。
function readLeadingBracket(text: string):
  | { inner: string; rest: string; open: string; close: string }
  | null {
  const open = text[0];
  const close = BRACKET_PAIRS[open];
  if (!close) return null;

  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) {
        return {
          inner: text.slice(1, index),
          rest: text.slice(index + 1),
          open,
          close,
        };
      }
    }
  }
  return null;
}

function stripSeparators(text: string): string {
  return text.replace(/^[\s|｜/_\\:：,，。·•~～—–-]+/u, "").trim();
}

// 括号段是否是独立元数据（更新进度/规格/网盘名/年份等）。若片名在段首，
// 例如“蝙蝠侠（全 9 部）”，不要把整段丢弃，后续清洗会只移除尾部元数据。
function isMetadataBracketSegment(inner: string): boolean {
  const value = inner.trim();
  const compact = value.replace(/[\s　]+/gu, "").toLowerCase();
  if (!compact) return true;
  if (/^(?:19|20)\d{2}$/.test(compact)) return true;
  if (
    /^(?:全(?:[一二三四五六七八九十百两\d]+)?(?:集|季|部)|[一二三四五六七八九十百两\d]+集全|第?[一二三四五六七八九十百两\d]+季(?:更至|更新至)?|s\d{1,2}(?:[-_]s?\d{1,2})?(?:e\d{1,3})?)$/i.test(
      compact
    )
  ) {
    return true;
  }
  if (GENERIC_METADATA_RE.test(value)) return true;
  return /^(?:已完结|完结|超前完结|更新至|更至|更\d|系列全收集|全收集|第二季更至|第三季更至|不易和谐|原盘未删减|夸克网盘|百度网盘|迅雷云盘|光鸭网盘|UC网盘|无水印|中字|字幕|双语|国语|粤语|内封|内嵌|类型[:：]|主演[:：]|剧情[:：]|国剧\s*\d{4}|美剧\s*\d{4}|美国\s*\d{4}|4k|8k|hdr|dv|remux|dts)/i.test(
    compact
  );
}

function unwrapWholeBracket(text: string): string {
  let value = text.trim();
  for (let count = 0; count < 4; count++) {
    const segment = readLeadingBracket(value);
    if (!segment || segment.rest.trim()) break;
    value = segment.inner.trim();
  }
  return value;
}

function cleanTitleSegment(segment: string): string {
  let title = unwrapWholeBracket(segment)
    .replace(/^标题[:：]\s*/u, "")
    .replace(/^\d{1,4}[.、]\s*/u, "")
    .replace(/^(?:电视剧|电影|剧版|美剧|日剧|韩剧|国产剧|港剧|台剧)[:：]\s*/iu, "")
    .trim();

  // 年份和“全 N 集/季/部”是最常见的尾部元数据，先处理括号形式，再处理普通标记。
  title = title
    .replace(/[（(\[]\s*(?:19|20)\d{2}\s*[）)\]]/gu, "")
    .replace(
      /[（(]\s*(?:全\s*)?[一二三四五六七八九十百两\d]+\s*(?:集|季|部)[^）)]*[）)]/giu,
      ""
    );

  const cutIndex = title.search(META_CUT_RE);
  if (cutIndex >= 0) title = title.slice(0, cutIndex);

  // “1-5 季全集”/“全集”这类合集后缀不是片名的一部分；保留片名本身，
  // 仍允许 titlesLooselyMatch 将“爱情公寓系列”与“爱情公寓”关联。
  title = title
    .replace(/\s+\d+\s*[-至]\s*\d+\s*季(?:全集)?$/iu, "")
    .replace(/\s+(?:全集|全收集)$/iu, "");

  // 去掉尾部仍残留的元数据括号段（例如“暗杀教室（全 2 季+剧场版）”）。
  for (let count = 0; count < 4; count++) {
    const match = title.match(/[【［\[(（]([^】］\]）)]+)[】］\]）)]\s*$/u);
    if (!match || !isMetadataBracketSegment(match[1])) break;
    title = title.slice(0, match.index).trim();
  }

  return title
    .replace(/^[《「『【［\[(（]+/u, "")
    .replace(/[》」』】］\]）)]+$/u, "")
    .replace(/[《》「」『』:：\s·]+$/gu, "")
    .trim();
}

function isPlausibleTitle(title: string): boolean {
  const value = title.trim();
  if (!value || GENERIC_METADATA_RE.test(value)) return false;
  if (/^(?:全|第)?[一二三四五六七八九十百两\d]+(?:集|季|部)$/u.test(value)) return false;
  return /[\u4e00-\u9fa5A-Za-z0-9]/u.test(value);
}

function isGenericPlainPrefix(prefix: string): boolean {
  const value = prefix.trim().replace(/[\s　]+/gu, "");
  return (
    GENERIC_METADATA_RE.test(prefix.trim()) ||
    /^(?:经典(?:儿童)?动画故事?|学习资料|资源合集|系列全收集|全收集)$/iu.test(value)
  );
}

function nextOpeningIndex(text: string): number {
  const indexes = Object.keys(BRACKET_PAIRS)
    .map((open) => text.indexOf(open))
    .filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

// 从 kkpan 资源名提取影片名候选：
// 剥前导装饰 → 跳过独立集数/状态/平台括号 → 读取标题括号或普通前缀 → 清理年份/画质后缀。
export function extractTitleCandidate(fileName: string): string {
  let remaining = stripSeparators(
    cleanKkpanTitle(fileName)
      .replace(/^标题[:：]\s*/u, "")
      .replace(LEADING_NOISE_RE, "")
      .trim()
  );

  for (let attempt = 0; attempt < 12 && remaining; attempt++) {
    remaining = stripSeparators(remaining);
    const bracket = readLeadingBracket(remaining);
    if (bracket) {
      const inner = cleanTitleSegment(bracket.inner);
      if (!isMetadataBracketSegment(bracket.inner) && isPlausibleTitle(inner)) {
        return inner.slice(0, 60);
      }
      remaining = bracket.rest;
      continue;
    }

    const openIndex = nextOpeningIndex(remaining);
    const prefix = openIndex >= 0 ? remaining.slice(0, openIndex) : remaining;
    const candidate = cleanTitleSegment(prefix);
    if (isPlausibleTitle(candidate)) {
      // “经典儿童动画故事《小马宝莉…》”这类描述性前缀不是片名，继续读取后面的显式标题括号。
      if (!(openIndex >= 0 && isGenericPlainPrefix(prefix))) {
        return candidate.slice(0, 60);
      }
    }
    if (openIndex >= 0) {
      remaining = remaining.slice(openIndex);
    } else {
      break;
    }
  }

  const fallback = cleanTitleSegment(cleanKkpanTitle(fileName));
  return (isPlausibleTitle(fallback) ? fallback : cleanKkpanTitle(fileName)).slice(
    0,
    60
  );
}

// 提取年份（[2021] / 2021 之类）
export function extractYear(fileName: string): string | undefined {
  const match = fileName.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  return match?.[1];
}

// 标题归一化：去全部非文字字符（中英文数字保留），用于宽松包含匹配
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s:：·・.,，。!！?？'"「」『』《》<>\[\]【】()（）\-_/\\|]+/g, "");
}

// 宽松匹配：归一化后一方包含另一方，且长度差不过分悬殊。
// 收紧规则（修复"九门→老九门 / 人鱼→美人鱼 / 悬案→悬案解码"错绑）：
//   1) 归一化后完全相等直接通过；
//   2) 否则较短串需被较长串 includes，且较短串长度 ≥ 3（挡住 2 字短串误命中），
//      同时较短串长度 ≥ ceil(较长串长度 × 0.5)（挡住一方明显是另一方片段的情形）。
// 代价：2 字片名的扩展形态（如"悬崖"→"悬崖之上"）不会被宽松匹配命中，
// 必须靠精确归一化等值或豆瓣搜索候选首项匹配。
export function titlesLooselyMatch(a: string, b: string): boolean {
  const na = normalizeTitleForMatch(a);
  const nb = normalizeTitleForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  return (
    longer.includes(shorter) &&
    shorter.length >= 3 &&
    shorter.length >= Math.ceil(longer.length * 0.5)
  );
}

// 严格匹配（补库模式用）：归一化等值优先；不等时再用收紧后的宽松匹配。
// 豆瓣列表项当前不带 year，因此本函数不直接做年份容差；调用方若有 year 信息
// 应在调用前自行校验，避免把不同年份的同名影片绑到一起。
export function titlesStrictlyMatch(a: string, b: string): boolean {
  const na = normalizeTitleForMatch(a);
  const nb = normalizeTitleForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return titlesLooselyMatch(a, b);
}
