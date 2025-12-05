import Redis from 'ioredis';

// Redis 客户端单例
let redis: Redis | null = null;

/**
 * 获取 Redis 客户端实例
 */
export function getRedisClient(): Redis {
  if (redis) {
    return redis;
  }

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError: (err: Error) => {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        return targetErrors.some(targetError => err.message.includes(targetError));
      }
    });

    redis.on('connect', () => {
      console.log('✅ Redis 连接成功');
    });

    redis.on('error', (err: Error) => {
      console.error('❌ Redis 连接错误:', err.message);
    });

    return redis;
  } catch (error) {
    console.error('❌ Redis 初始化失败:', error);
    throw error;
  }
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedis() {
  if (redis) {
    await redis.quit();
    redis = null;
    console.log('✅ Redis 连接已关闭');
  }
}

/**
 * Redis 缓存操作类
 */
export class RedisCache {
  private redis: Redis;
  private defaultTTL: number; // 默认过期时间（秒）

  constructor(ttl: number = 3600) {
    this.redis = getRedisClient();
    this.defaultTTL = ttl;
  }

  /**
   * 获取缓存
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      console.error(`Redis GET 错误 [${key}]:`, error);
      return null;
    }
  }

  /**
   * 设置缓存
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    try {
      const expiration = ttl || this.defaultTTL;
      const serialized = JSON.stringify(value);
      await this.redis.setex(key, expiration, serialized);
      return true;
    } catch (error) {
      console.error(`Redis SET 错误 [${key}]:`, error);
      return false;
    }
  }

  /**
   * 删除缓存
   */
  async del(key: string): Promise<boolean> {
    try {
      await this.redis.del(key);
      return true;
    } catch (error) {
      console.error(`Redis DEL 错误 [${key}]:`, error);
      return false;
    }
  }

  /**
   * 检查缓存是否存在
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`Redis EXISTS 错误 [${key}]:`, error);
      return false;
    }
  }

  /**
   * 批量删除缓存（按模式）
   */
  async delPattern(pattern: string): Promise<number> {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length === 0) return 0;
      await this.redis.del(...keys);
      return keys.length;
    } catch (error) {
      console.error(`Redis DEL PATTERN 错误 [${pattern}]:`, error);
      return 0;
    }
  }

  /**
   * 获取缓存剩余过期时间（秒）
   */
  async ttl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key);
    } catch (error) {
      console.error(`Redis TTL 错误 [${key}]:`, error);
      return -1;
    }
  }
}

/**
 * 内存缓存降级方案（当 Redis 不可用时）
 */
export class MemoryCache {
  private cache: Map<string, { value: string; expireAt: number }>;

  constructor() {
    this.cache = new Map();
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

  async set<T>(key: string, value: T, ttl: number = 3600): Promise<boolean> {
    const serialized = JSON.stringify(value);
    const expireAt = Date.now() + ttl * 1000;
    this.cache.set(key, { value: serialized, expireAt });
    return true;
  }

  async del(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.cache.has(key) && Date.now() <= (this.cache.get(key)?.expireAt || 0);
  }

  async delPattern(pattern: string): Promise<number> {
    const regex = new RegExp(pattern.replace('*', '.*'));
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
 * 缓存工厂：自动选择 Redis 或内存缓存
 */
export function createCache(ttl: number = 3600): RedisCache | MemoryCache {
  try {
    // 尝试使用 Redis
    if (process.env.REDIS_URL) {
      return new RedisCache(ttl);
    }
  } catch {
    console.warn('⚠️ Redis 不可用，降级使用内存缓存');
  }
  
  // 降级使用内存缓存
  return new MemoryCache();
}
