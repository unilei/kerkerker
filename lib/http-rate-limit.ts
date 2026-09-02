/**
 * 轻量内存限速（PoC 用）：固定窗口计数，单进程内有效。
 * 用 globalThis 缓存桶，规避 dev HMR 重建模块导致计数丢失。
 */

interface RateBucket {
  count: number;
  resetAt: number;
}

const globalForRateLimit = globalThis as typeof globalThis & {
  __kerkerkerRateBuckets?: Map<string, RateBucket>;
};

const buckets: Map<string, RateBucket> =
  globalForRateLimit.__kerkerkerRateBuckets || new Map();
globalForRateLimit.__kerkerkerRateBuckets = buckets;

/** 窗口内超限返回 false；key 由调用方自行拼（如 `save:${ip}`） */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) {
    // 防桶无限增长：过期批量清理
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** 提取请求方 IP（本站部署在反代/Cloudflare 后，优先取转发头） */
export function requestClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("cf-connecting-ip") || "unknown";
}
