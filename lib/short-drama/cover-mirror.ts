import { assertSafeOutboundUrl } from "@/lib/url-security";

/**
 * 短剧封面镜像：把从夸克网盘下载到的封面字节上传到 Cloudflare R2。
 *
 * 复用与 kerkerker-douban-service 完全一致的 R2 通道契约（同一组 env、
 * 同一个鉴权 Upload Worker），可与豆瓣图片共用 Bucket：
 *   CLOUDFLARE_R2_PUBLIC_URL       Bucket 根目录的公开访问域名
 *   CLOUDFLARE_R2_UPLOAD_API_URL   上传 Worker /objects 基址
 *   CLOUDFLARE_R2_UPLOAD_API_TOKEN Bearer token（wrangler secret UPLOAD_TOKEN）
 *   CLOUDFLARE_R2_COVER_KEY_PREFIX 短剧封面顶层目录（缺省
 *                                  "short-drama-covers"；刻意独立于
 *                                  douban-service 的 CLOUDFLARE_R2_KEY_PREFIX，
 *                                  共用 Bucket 时两套前缀互不覆盖）
 *   CLOUDFLARE_R2_MAX_IMAGE_BYTES  大小上限（缺省 10MB，与 douban-service 一致）
 *
 * Worker 侧约束（cloudflare/image-upload-worker）：key 仅允许
 * [A-Za-z0-9._/-] 且不能以 / 开头或含 ..；Content-Type 必须 image/*。
 * 未配置 R2 时返回 null，调用方保留无封面状态（详情页有占位图兜底）。
 */

const UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COVER_BYTES = 10 * 1024 * 1024;
const DEFAULT_COVER_KEY_PREFIX = "short-drama-covers";
const ALLOWED_COVER_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export interface CoverUploadInput {
  /** 不含顶层前缀的对象键（如 81864.jpg），允许 [A-Za-z0-9._/-] */
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

/** 与 douban-service 的 objectKey 语义一致：可选顶层前缀 + 文件键。
 *  前缀用短剧专属的 CLOUDFLARE_R2_COVER_KEY_PREFIX（缺省
 *  "short-drama-covers"），刻意不读 douban-service 的
 *  CLOUDFLARE_R2_KEY_PREFIX——两者共用 Bucket，前缀必须互不覆盖。 */
function coverObjectKey(key: string): string {
  const prefix =
    process.env.CLOUDFLARE_R2_COVER_KEY_PREFIX?.trim() || DEFAULT_COVER_KEY_PREFIX;
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const normalizedKey = key.replace(/^\/+/, "");
  return normalizedPrefix
    ? `${normalizedPrefix}/${normalizedKey}`
    : normalizedKey;
}

/** 上传封面到 R2，返回公开 URL；未配置/失败返回 null（不阻塞转存主流程） */
export async function uploadCoverToR2(
  input: CoverUploadInput
): Promise<string | null> {
  if (!isR2CoverMirrorConfigured()) return null;
  const contentType = input.contentType.toLowerCase();
  if (!ALLOWED_COVER_TYPES.has(contentType)) return null;

  const maxBytes = Number(
    process.env.CLOUDFLARE_R2_MAX_IMAGE_BYTES || DEFAULT_MAX_COVER_BYTES
  );
  if (input.body.length === 0 || input.body.length > maxBytes) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(input.key) || input.key.includes("..")) {
    return null;
  }

  const uploadBase = process.env.CLOUDFLARE_R2_UPLOAD_API_URL!.trim().replace(/\/+$/, "");
  const publicBase = process.env.CLOUDFLARE_R2_PUBLIC_URL!.trim().replace(/\/+$/, "");
  const token = process.env.CLOUDFLARE_R2_UPLOAD_API_TOKEN!.trim();
  const objectKey = coverObjectKey(input.key);

  try {
    // 上传 Worker 与公开基址都是受控 env，不经过出站 URL 策略；
    // 但公开 URL 仍校验一下合法性，防止 env 配置错误生成坏链接。
    const publicUrl = `${publicBase}/${objectKey}`;
    await assertSafeOutboundUrl(publicUrl);

    const response = await fetch(`${uploadBase}/${objectKey}`, {
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
      console.warn(`封面 R2 上传失败: HTTP ${response.status} key=${objectKey}`);
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

/** 夸克签名下载直链 → 字节（封面/元数据小文件通用）。
 *  下载 CDN 校验账号态：不带 cookie 时返回 412，故在 quark.cn 域名上
 *  附带凭证 cookie（其他域名一律不带，防凭证外泄）。 */
export async function fetchSignedDownloadBytes(
  downloadUrl: string,
  maxBytes: number = DEFAULT_MAX_COVER_BYTES,
  cookie?: string
): Promise<{ body: Uint8Array; contentType: string } | null> {
  try {
    await assertSafeOutboundUrl(downloadUrl);
    const headers: Record<string, string> = {
      "user-agent": "Mozilla/5.0",
      referer: "https://pan.quark.cn/",
    };
    if (cookie && /(^|\.)quark\.cn$/i.test(new URL(downloadUrl).hostname)) {
      headers.cookie = cookie;
    }
    const response = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers,
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
