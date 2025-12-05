import { NextResponse } from 'next/server';
import { doubanSearchSubjects, getProxyStatus } from '@/lib/douban-client';

/**
 * 电影分类 API
 * GET /api/douban/movies
 * 
 * 功能：获取各类电影数据
 * - 热门电影
 * - 高分电影
 * - 经典电影
 * - 各类型电影（动作、喜剧、科幻等）
 */

interface MovieData {
  id: string;
  title: string;
  rate: string;
  url: string;
  cover: string;
  episode_info?: string;
}

interface CategoryData {
  name: string;
  data: MovieData[];
}

// 内存缓存
let cacheStore: { data: CategoryData[]; timestamp: number } | null = null;
const CACHE_EXPIRATION = 60 * 60 * 1000; // 缓存1小时

export async function GET() {
  try {
    // 检查缓存
    if (cacheStore && Date.now() - cacheStore.timestamp < CACHE_EXPIRATION) {
      return NextResponse.json({
        code: 200,
        data: cacheStore.data,
        source: 'cache',
        cachedAt: new Date(cacheStore.timestamp).toISOString()
      });
    }

    const proxyStatus = getProxyStatus();
    console.log('🎬 开始获取电影分类数据...', proxyStatus.enabled ? `(代理: ${proxyStatus.count + " 个代理"})` : '');

    // 并行抓取各类电影数据
    const [
      hotMovies,
      topRated,
      action,
      comedy,
      scifi,
      thriller,
      romance,
      animation
    ] = await Promise.all([
      fetchDoubanMovies('', '热门'),
      fetchDoubanMovies('', '豆瓣高分'),
      fetchDoubanMovies('', '动作'),
      fetchDoubanMovies('', '喜剧'),
      fetchDoubanMovies('', '科幻'),
      fetchDoubanMovies('', '惊悚'),
      fetchDoubanMovies('', '爱情'),
      fetchDoubanMovies('', '动画')
    ]);

    const resultData: CategoryData[] = [
      {
        name: '热门电影',
        data: hotMovies.subjects || []
      },
      {
        name: '豆瓣高分',
        data: topRated.subjects || []
      },
      {
        name: '动作片',
        data: action.subjects || []
      },
      {
        name: '喜剧片',
        data: comedy.subjects || []
      },
      {
        name: '科幻片',
        data: scifi.subjects || []
      },
      {
        name: '惊悚片',
        data: thriller.subjects || []
      },
      {
        name: '爱情片',
        data: romance.subjects || []
      },
      {
        name: '动画电影',
        data: animation.subjects || []
      }
    ];

    // 更新缓存
    cacheStore = {
      data: resultData,
      timestamp: Date.now()
    };

    console.log('✅ 电影分类数据获取成功');

    return NextResponse.json({
      code: 200,
      data: resultData,
      source: 'fresh',
      totalCategories: resultData.length,
      totalItems: resultData.reduce((sum, cat) => sum + cat.data.length, 0)
    });

  } catch (error) {
  
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
 * 抓取豆瓣电影数据
 */
async function fetchDoubanMovies(type: string, tag: string) {
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
 * DELETE /api/douban/movies
 */
export async function DELETE() {
  cacheStore = null;
  
  return NextResponse.json({
    code: 200,
    message: '电影缓存已清除'
  });
}
