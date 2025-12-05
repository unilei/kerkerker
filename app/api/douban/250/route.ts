import { NextResponse } from 'next/server';
import { createCache } from '@/lib/redis';
import { doubanSearchSubjects, getProxyStatus } from '@/lib/douban-client';

// 缓存数据接口
interface CacheData {
  subjects: Array<{
    id: string;
    title: string;
    rate: string;
    url: string;
    cover: string;
  }>;
  timestamp: number;
}

// Redis 缓存配置
const cache = createCache(86400); // 缓存1天
const CACHE_KEY = 'douban:top250:all';

/**
 * 豆瓣 Top 250 API
 * GET /api/douban/250
 * 
 * 获取完整的 250 部电影数据
 */
export async function GET() {
  try {
    // 检查 Redis 缓存
    const cachedData = await cache.get<CacheData>(CACHE_KEY);
    if (cachedData) {
      return NextResponse.json({
        code: 200,
        data: {
          subjects: cachedData.subjects,
        },
        source: 'redis-cache',
        total: cachedData.subjects.length,
      });
    }

    const proxyStatus = getProxyStatus();
    console.log('🚀 开始抓取豆瓣 Top 250...', proxyStatus.enabled ? `(代理: ${proxyStatus.count + " 个代理"})` : '');

    // 分批抓取（每批25部，共10批）
    const allMovies: Array<{
      id: string;
      title: string;
      rate: string;
      url: string;
      cover: string;
    }> = [];

    // 并行抓取10批数据
    const batchPromises = [];
    for (let i = 0; i < 10; i++) {
      batchPromises.push(fetchTop250Batch(i * 25));
    }

    const results = await Promise.all(batchPromises);
    
    // 合并结果
    results.forEach(batch => {
      if (batch.subjects) {
        allMovies.push(...batch.subjects);
      }
    });

    console.log(`✅ Top 250 抓取完成，共 ${allMovies.length} 部`);

    // 更新 Redis 缓存
    await cache.set(CACHE_KEY, {
      subjects: allMovies,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      code: 200,
      data: {
        subjects: allMovies,
      },
      source: 'fresh-data',
      total: allMovies.length,
    });

  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        msg: 'error',
        error: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 }
    );
  }
}

/**
 * 抓取单批 Top 250 数据
 */
async function fetchTop250Batch(start: number) {
  try {
    const data = await doubanSearchSubjects({
      type: 'movie',
      tag: '豆瓣高分',
      page_limit: 25,
      page_start: start
    });
    
    console.log(`✓ 抓取 Top 250 第 ${start / 25 + 1} 批: ${data.subjects?.length || 0} 部`);
    
    return data;
  } catch (error) {
    console.error(`✗ 抓取 Top 250 第 ${start / 25 + 1} 批失败:`, error);
    return { subjects: [] };
  }
}

/**
 * 清除缓存
 * DELETE /api/douban/250
 */
export async function DELETE() {
  await cache.del(CACHE_KEY);
  
  return NextResponse.json({
    code: 200,
    message: 'Top 250 缓存已清除'
  });
}
