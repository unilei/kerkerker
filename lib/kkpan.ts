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

// 按关键词搜索公开目录（仅转存成功资源），失败抛错由调用方处理。
// page 从 1 开始，limit 上限 50。
export async function searchKkpanResources(
  keyword: string,
  limit = 40,
  page = 1
): Promise<KkpanResource[]> {
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

  const payload = (await response.json()) as { data?: KkpanPublicRow[] };
  const rows = payload.data || [];

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
// 接口无时间过滤参数，靠调用方做水位游标（kkpan_id 集合命中即停）保证增量。
export async function listKkpanPage(
  page = 1,
  limit = 50
): Promise<KkpanResource[]> {
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
  const payload = (await response.json()) as { data?: KkpanPublicRow[] };
  const rows = payload.data || [];
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

// 元数据截断标记：规格/音轨/字幕/集数/年份括号/中括号等。
// 真实 kkpan 资源名基本是「片名+季 (年份) 规格…」结构，片名在最前面。
const META_CUT_RE = new RegExp(
  [
    "\\[|【",
    "（(?:19|20)\\d{2}）|\\((?:19|20)\\d{2}\\)", // 年份括号
    "\\b(?:4K|8K|2K|1080[Pp]?|2160[Pp]?|720[Pp]?|60FPS|120FPS|10bit|HDR10?|DV|REMUX|DTS|H26[45]|WEB-?DL|BluRay)\\b",
    "内封|内嵌|官中|简中|简体|中字|双语|国语|粤语|蓝光|高清|全集|完结|更至|更新至|全\\d+集|S\\d{1,2}E\\d{1,2}|附第|超分|高码|双版本|特效字幕|\\d+集",
  ].join("|"),
  "i"
);

// 前导装饰字符（emoji、符号块等；保留中文/英文/数字/书名号/方头括号）
const LEADING_NOISE_RE = /^[^\u4e00-\u9fa5A-Za-z0-9《【[]+/;

// 括号段是否为纯元数据（更新进度/规格/网盘名/年份等）
function isMetadataBracketSegment(inner: string): boolean {
  return (
    /更新|更至|全集|完结|夸克|网盘|百度|迅雷|光鸭|UC|无水印|中字|字幕|双语|国语|粤语|内封|内嵌/.test(
      inner
    ) ||
    /\b(4K|8K|2K|1080|2160|HDR|DV|REMUX|DTS)\b/i.test(inner) ||
    /^((19|20)\d{2})$/.test(inner) ||
    /^[\d\s~～\-至集季部]+$/.test(inner)
  );
}

// 从 kkpan 资源名提取影片名候选：
// 剥前导装饰 → 剥纯元数据括号段 → 在第一个元数据标记处截断取前缀
export function extractTitleCandidate(fileName: string): string {
  let text = cleanKkpanTitle(fileName)
    .replace(/^标题[:：]\s*/, "")
    .replace(LEADING_NOISE_RE, "")
    .trim();

  // 以纯元数据括号段开头（如【更新至02集】）时逐段剥离，遇内容括号（标题）停止
  while (/^[【[]/.test(text)) {
    const match = text.match(/^[【[]([^】\]]*)[】\]]/);
    if (!match || !isMetadataBracketSegment(match[1].trim())) break;
    text = text.slice(match[0].length).replace(LEADING_NOISE_RE, "").trim();
  }
  // 标题本身包在括号里的场景（【足球教练 第四季（2026）】【4K】…）：解开开括号
  text = text.replace(/^[【[]/, "").trim();

  const cutIndex = text.search(META_CUT_RE);
  const title = (
    cutIndex > 0 ? text.slice(0, cutIndex) : text
  )
    .replace(/^(美剧|日剧|韩剧|国产剧|港剧|台剧|剧版|电影)[:：]?/, "")
    .replace(/^[《【[]|[】\]》][^】\]》]*$/g, "")
    .replace(/[《》:：\s·]+$/g, "")
    .trim();

  return title.slice(0, 60) || cleanKkpanTitle(fileName).slice(0, 60);
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
