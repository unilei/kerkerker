import { assertSafeOutboundUrl } from "@/lib/url-security";

/**
 * 短剧封面镜像：把从夸克网盘下载到的封面字节上传到 Cloudflare R2。
 *
 * 复用宿主已有的 R2 上传 Worker 通道（与 asset.image 镜像同一套 env 契约）：
 *   CLOUDFLARE_R2_PUBLIC_URL       公开访问基址
 *   CLOUDFLARE_R2_UPLOAD_API_URL   上传 Worker 基址（PUT {key} + Bearer）
 *   CLOUDFLARE_R2_UPLOAD_API_TOKEN Bearer token
 * R2 未配置时返回 null，调用方保留无封面状态（详情页有占位图兜底）。
 */

const UPLOAD_TIMEOUT_MS = 30_000;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const ALLOWED_COVER_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export interface CoverUploadInput {
  /** 对象键（如 short-drama-covers/81864.jpg），不再二次编码 */
  key: string;
  body: Uint8Array;
  contentType: string;
}

export function isR2CoverMirrorConfigured(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_R2_PUBLIC_URL?.trim() &&
      process.env.CLOUDFLARE_R2_UPLOAD_API_URL?.trim() &&
      process.env.CLOUDFLARE_R2_UPLOAD_API_TOKEN?.trim()
  );
}

/** 上传封面到 R2，返回公开 URL；未配置/失败返回 null（不阻塞转存主流程） */
export async function uploadCoverToR2(
  input: CoverUploadInput
): Promise<string | null> {
  if (!isR2CoverMirrorConfigured()) return null;
  const contentType = input.contentType.toLowerCase();
  if (!ALLOWED_COVER_TYPES.has(contentType)) return null;
  if (input.body.length === 0 || input.body.length > MAX_COVER_BYTES) return null;
  if (!/^[a-z0-9][a-z0-9/._-]*$/i.test(input.key)) return null;

  const uploadBase = process.env.CLOUDFLARE_R2_UPLOAD_API_URL!.trim().replace(/\/+$/, "");
  const publicBase = process.env.CLOUDFLARE_R2_PUBLIC_URL!.trim().replace(/\/+$/, "");
  const token = process.env.CLOUDFLARE_R2_UPLOAD_API_TOKEN!.trim();

  try {
    // 上传 Worker 与公开基址都是受控 env，不经过出站 URL 策略；
    // 但公开 URL 仍校验一下合法性，防止 env 配置错误生成坏链接。
    const publicUrl = `${publicBase}/${input.key}`;
    await assertSafeOutboundUrl(publicUrl);

    const response = await fetch(`${uploadBase}/${input.key}`, {
      method: "PUT",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      body: Buffer.from(input.body),
    });
    if (!response.ok) {
      console.warn(`封面 R2 上传失败: HTTP ${response.status} key=${input.key}`);
      return null;
    }
    return publicUrl;
  } catch (error) {
    console.warn(
      "封面 R2 上传异常:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/** 夸克签名下载直链 → 字节（封面/元数据小文件通用） */
export async function fetchSignedDownloadBytes(
  downloadUrl: string,
  maxBytes: number = MAX_COVER_BYTES
): Promise<{ body: Uint8Array; contentType: string } | null> {
  try {
    await assertSafeOutboundUrl(downloadUrl);
    const response = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0", referer: "https://pan.quark.cn/" },
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(length) && length > maxBytes) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > maxBytes) return null;
    const contentType = (response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    return { body: buffer, contentType };
  } catch {
    return null;
  }
}

/** 从文件名推断 MIME（夸克 file/sort 不回 content-type） */
export function contentTypeForFileName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}
