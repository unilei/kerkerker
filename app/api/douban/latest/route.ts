import { NextResponse } from 'next/server';
import { createCache } from '@/lib/redis';
import { doubanSearchSubjects, getProxyStatus } from '@/lib/douban-client';

/**
 * 最新内容 API
 * GET /api/douban/latest
 * 
 * 功能：获取最新上映/播出的影视内容
 * - 院线新片
 * - 最新上映
 * - 即将上映
 * - 新剧上线
 * - 本周口碑榜
 */

interface LatestData {
  id: string;
  title: string;
  rate: string;
  url: string;
  cover: string;
  episode_info?: string;
}

interface CategoryData {
  name: string;
  data: LatestData[];
}

// Redis 缓存配置
const cache = createCache(1800); // 缓存30分钟（最新内容更新更频繁）
const CACHE_KEY = 'douban:latest:all';

export async function GET() {
  try {
    // 检查 Redis 缓存
    const cachedData = await cache.get<CategoryData[]>(CACHE_KEY);
    if (cachedData) {
      return NextResponse.json({
        code: 200,
        data: cachedData,
        source: 'redis-cache'
      });
    }

    const proxyStatus = getProxyStatus();
    console.log('🆕 开始获取最新内容数据...', proxyStatus.enabled ? `(代理: ${proxyStatus.count + " 个代理"})` : '');

    // 并行抓取最新内容数据
    const [
      nowPlaying,
      newMovies,
      comingSoon,
      newTv,
      weeklyTop,
      trending
    ] = await Promise.all([
      fetchDoubanLatest('', '院线新片'),
      fetchDoubanLatest('', '最新'),
      fetchDoubanLatest('', '即将上映'),
      fetchDoubanLatest('tv', '最新'),
      fetchDoubanLatest('', '本周口碑榜'),
      fetchDoubanLatest('', '热门')
    ]);

    const resultData: CategoryData[] = [
      {
        name: '院线新片',
        data: nowPlaying.subjects || []
      },
      {
        name: '最新电影',
        data: newMovies.subjects || []
      },
      {
        name: '即将上映',
        data: comingSoon.subjects || []
      },
      {
        name: '新剧上线',
        data: newTv.subjects || []
      },
      {
        name: '本周口碑榜',
        data: weeklyTop.subjects || []
      },
      {
        name: '热门趋势',
        data: trending.subjects || []
      }
    ];

    // 更新 Redis 缓存
    await cache.set(CACHE_KEY, resultData);

    console.log('✅ 最新内容数据获取成功');

    return NextResponse.json({
      code: 200,
      data: resultData,
      source: 'fresh',
      totalCategories: resultData.length,
      totalItems: resultData.reduce((sum, cat) => sum + cat.data.length, 0)
    });

  } catch (error) {
    console.error('❌ 最新内容数据获取失败:', error);
    
    return NextResponse.json(
      {
        code: 500,
        msg: 'error',
        error: error instanceof Error ? error.message : '未知错误'
      },
      { status: 500 }
    );
  }
}

/**
 * 抓取豆瓣最新内容数据
 */
async function fetchDoubanLatest(type: string, tag: string) {
  try {
    const data = await doubanSearchSubjects({
      type,
      tag,
      page_limit: 24,
      page_start: 0
    });
    console.log(`✓ 抓取成功: ${tag} (${data.subjects?.length || 0}条)`);
    return data;
  } catch (error) {
    console.error(`✗ 抓取失败: ${tag}`, error);
    return { subjects: [] };
  }
}

/**
 * 清除缓存接口
 * DELETE /api/douban/latest
 */
export async function DELETE() {
  await cache.del(CACHE_KEY);
  
  return NextResponse.json({
    code: 200,
    message: '最新内容缓存已清除'
  });
}
