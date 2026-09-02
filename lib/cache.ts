/**
 * 进程内 TTL 缓存（短剧公开读路径专用）。
 *
 * 根布局读取 cookies()（语言偏好）令全站强制动态渲染，ISR 不可用；
 * 生产为单容器部署（GHCR 镜像流），进程内缓存承担公开读削峰
 * （详情页 / 标签聚合 / 相关推荐 / sitemap）。写路径调用
 * bumpShortDramaCache() 按前缀整体清除实现即时失效，TTL 只兜底
 * 跨进程漂移（如绕过应用直接改库）与多实例部署时的最终一致。
 *
 * 约定：命中返回跨请求共享的同一对象引用，调用方视为只读，不得原地修改。
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const MAX_ENTRIES = 1_000;

const store = new Map<string, CacheEntry>();
// 并发未命中时合并为同一次加载，避免惊群打穿到数据库
const inflight = new Map<string, Promise<unknown>>();

/** 短剧公开读缓存命名空间（写路径 bump 按此前缀整体清除） */
export const SHORT_DRAMA_CACHE_PREFIX = "short-drama:";

/** 短剧公开读数据有写路径即时失效，TTL 只兜底跨进程漂移 */
export const SHORT_DRAMA_CACHE_TTL_MS = 5 * 60 * 1000;
/** sitemap 数据量大且只有蜘蛛低频访问，允许更长的缓存窗口 */
export const SHORT_DRAMA_SITEMAP_CACHE_TTL_MS = 30 * 60 * 1000;

export async function cachedRead<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const task = (async () => {
    const value = await load();
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    evictOverflow();
    return value;
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

function evictOverflow(): void {
  if (store.size <= MAX_ENTRIES) return;
  // 先清已过期条目；仍超限再按插入序逐出最旧条目（近似 LRU）
  const now = Date.now();
  for (const [key, entry] of store) {
    if (store.size <= MAX_ENTRIES) return;
    if (entry.expiresAt <= now) store.delete(key);
  }
  for (const key of store.keys()) {
    if (store.size <= MAX_ENTRIES) return;
    store.delete(key);
  }
}

/** 短剧数据写路径调用：整体失效公开读缓存 */
export function bumpShortDramaCache(): void {
  for (const key of store.keys()) {
    if (key.startsWith(SHORT_DRAMA_CACHE_PREFIX)) store.delete(key);
  }
}
