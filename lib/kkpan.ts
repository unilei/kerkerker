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

// 按关键词搜索公开目录（仅转存成功资源），失败抛错由调用方处理
export async function searchKkpanResources(
  keyword: string,
  limit = 40
): Promise<KkpanResource[]> {
  const params = new URLSearchParams({
    search: keyword,
    page: "1",
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
