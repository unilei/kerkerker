/**
 * 内存缓存实现
 *
 * 简化版缓存，用于替代 Redis
 * 适用于单实例部署场景
 */

export class MemoryCache {
  private cache: Map<string, { value: string; expireAt: number }>;
  private defaultTTL: number;

  constructor(ttl: number = 3600) {
    this.cache = new Map();
    this.defaultTTL = ttl;
  }

  async get<T>(key: string): Promise<T | null> {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expireAt) {
      this.cache.delete(key);
      return null;
    }

    return JSON.parse(item.value) as T;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    const expiration = ttl || this.defaultTTL;
    const serialized = JSON.stringify(value);
    const expireAt = Date.now() + expiration * 1000;
    this.cache.set(key, { value: serialized, expireAt });
    return true;
  }

  async del(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (
      this.cache.has(key) && Date.now() <= (this.cache.get(key)?.expireAt || 0)
    );
  }

  async delPattern(pattern: string): Promise<number> {
    const regex = new RegExp(pattern.replace("*", ".*"));
    let count = 0;
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  async ttl(key: string): Promise<number> {
    const item = this.cache.get(key);
    if (!item) return -2;
    const remaining = Math.floor((item.expireAt - Date.now()) / 1000);
    return remaining > 0 ? remaining : -1;
  }
}

/**
 * 创建缓存实例
 */
export function createCache(ttl: number = 3600): MemoryCache {
  return new MemoryCache(ttl);
}
