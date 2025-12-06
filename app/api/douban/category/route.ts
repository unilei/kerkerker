import { NextRequest, NextResponse } from 'next/server';
import { createCache } from '@/lib/redis';
import { doubanSearchSubjects, getProxyStatus } from '@/lib/douban-client';

// Redis 缓存配置
const cache = createCache(3600); // 缓存1小时

// 分类标签映射
const CATEGORY_TAG_MAP: Record<string, { tag: string; type: string }> = {
  'in_theaters': { tag: '热门', type: '' },
  'hot_movies': { tag: '热门', type: 'movie' },
  'hot_tv': { tag: '热门', type: 'tv' },
  'us_tv': { tag: '美剧', type: 'tv' },
  'jp_tv': { tag: '日剧', type: 'tv' },
  'kr_tv': { tag: '韩剧', type: 'tv' },
  'anime': { tag: '日本动画', type: 'tv' },
  'documentary': { tag: '纪录片', type: 'tv' },
  'variety': { tag: '综艺', type: 'tv' },
  'chinese_tv': { tag: '国产剧', type: 'tv' },
};

/**
 * 分类分页 API
 * GET /api/douban/category
 * 
 * 参数：
 * - category: 分类类型 (in_theaters, hot_movies, etc.)
 * - page: 页码 (从1开始)
 * - limit: 每页数量 (默认20)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const category = searchParams.get('category') || 'in_theaters';
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    // 验证参数
    if (page < 1) {
      return NextResponse.json({ code: 400, error: '页码必须大于0' }, { status: 400 });
    }

    if (limit < 1 || limit > 50) {
      return NextResponse.json({ code: 400, error: '每页数量必须在1-50之间' }, { status: 400 });
    }

    // 获取分类配置
    const categoryConfig = CATEGORY_TAG_MAP[category];
    if (!categoryConfig) {
      return NextResponse.json({ code: 400, error: '无效的分类类型' }, { status: 400 });
    }

    const pageStart = (page - 1) * limit;
    const cacheKey = `douban:category:${category}:page${page}:limit${limit}`;

    // 检查 Redis 缓存
    const cachedData = await cache.get<{
      subjects: Array<{
        id: string;
        title: string;
        rate: string;
        url: string;
        cover: string;
      }>;
      total: number;
    }>(cacheKey);

    if (cachedData) {
      return NextResponse.json({
        code: 200,
        data: {
          subjects: cachedData.subjects,
          pagination: {
            page,
            limit,
            total: cachedData.total,
            hasMore: pageStart + cachedData.subjects.length < cachedData.total
          }
        },
        source: 'redis-cache'
      });
    }

    const proxyStatus = getProxyStatus();
    console.log(`🔍 分页获取分类数据: ${category}, 页${page}, 每页${limit}`, 
      proxyStatus.enabled ? `(代理: ${proxyStatus.count}个)` : '');

    // 获取数据
    const data = await doubanSearchSubjects({
      type: categoryConfig.type,
      tag: categoryConfig.tag,
      page_limit: limit,
      page_start: pageStart
    });

    const subjects = data.subjects || [];
    
    // 估算总数（豆瓣API不返回总数，假设每个分类最多有100条）
    // 如果返回的数据少于请求数量，说明已经到末尾
    const estimatedTotal = subjects.length < limit ? pageStart + subjects.length : 100;

    console.log(`✓ 分页获取成功: ${category} 页${page} (${subjects.length}条)`);

    // 缓存结果
    await cache.set(cacheKey, {
      subjects,
      total: estimatedTotal
    });

    return NextResponse.json({
      code: 200,
      data: {
        subjects,
        pagination: {
          page,
          limit,
          total: estimatedTotal,
          hasMore: subjects.length === limit
        }
      },
      source: 'fresh-data'
    });

  } catch (error) {
    console.error('❌ 分页获取分类数据失败:', error);
    return NextResponse.json(
      {
        code: 500,
        error: error instanceof Error ? error.message : '未知错误'
      },
      { status: 500 }
    );
  }
}
