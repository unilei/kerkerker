import { NextRequest, NextResponse } from 'next/server';
import { createCache } from '@/lib/redis';
import { 
  doubanSubjectSuggest,
  doubanAdvancedSearch,
  doubanSearchTags,
  type DoubanSuggestItem,
  type DoubanNewSearchSubject
} from '@/lib/douban-client';

// Redis 缓存配置
const cache = createCache(1800); // 缓存30分钟

/**
 * 豆瓣搜索 API
 * GET /api/douban/search?q=关键词&type=movie
 * 
 * 参数:
 * - q: 搜索关键词 (必填)
 * - type: 类型 movie|tv (可选，默认搜索全部)
 * - sort: 排序 U|T|S|R (可选)
 * - genres: 类型筛选 (可选)
 * - year_range: 年份范围 如 "2020,2024" (可选)
 * - start: 起始位置 (可选)
 * - limit: 返回数量 (可选)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q');
    const type = searchParams.get('type') as 'movie' | 'tv' | null;
    const sort = searchParams.get('sort') as 'U' | 'T' | 'S' | 'R' | null;
    const genres = searchParams.get('genres');
    const yearRange = searchParams.get('year_range');
    const start = parseInt(searchParams.get('start') || '0');
    const limit = parseInt(searchParams.get('limit') || '20');

    if (!query) {
      return NextResponse.json(
        { code: 400, error: '缺少搜索关键词参数 q' },
        { status: 400 }
      );
    }

    // 构建缓存键
    const cacheKey = `douban:search:${query}:${type || 'all'}:${sort || 'U'}:${genres || ''}:${yearRange || ''}:${start}:${limit}`;
    
    // 检查缓存
    const cachedData = await cache.get<{
      suggest: DoubanSuggestItem[];
      advanced: DoubanNewSearchSubject[];
    }>(cacheKey);
    
    if (cachedData) {
      return NextResponse.json({
        code: 200,
        data: cachedData,
        source: 'redis-cache'
      });
    }

    console.log(`🔍 搜索豆瓣: ${query}`);

    // 并行执行搜索
    const [suggestResult, advancedResult] = await Promise.all([
      // 快速搜索建议（返回ID、封面等基础信息）
      doubanSubjectSuggest(query),
      // 高级搜索（支持筛选条件）
      type ? doubanAdvancedSearch({
        tags: type === 'movie' ? '电影' : '电视剧',
        sort: sort || 'U',
        genres: genres || undefined,
        year_range: yearRange || undefined,
        start,
        limit
      }).then(r => r.data || []).catch(() => []) : Promise.resolve([])
    ]);

    // 过滤搜索建议结果
    let filteredSuggest = suggestResult;
    if (type) {
      filteredSuggest = suggestResult.filter(item => {
        if (type === 'movie') {
          return item.type === 'movie';
        } else if (type === 'tv') {
          return item.type === 'tv';
        }
        return true;
      });
    }

    const resultData = {
      suggest: filteredSuggest,
      advanced: advancedResult
    };

    // 更新缓存
    await cache.set(cacheKey, resultData);

    console.log(`✅ 搜索完成: ${filteredSuggest.length} 条建议, ${advancedResult.length} 条高级搜索结果`);

    return NextResponse.json({
      code: 200,
      data: resultData,
      source: 'fresh',
      query,
      type: type || 'all'
    });

  } catch (error) {
    console.error('❌ 豆瓣搜索失败:', error);
    
    return NextResponse.json(
      {
        code: 500,
        error: error instanceof Error ? error.message : '搜索失败'
      },
      { status: 500 }
    );
  }
}

/**
 * 获取搜索标签
 * POST /api/douban/search
 * Body: { type: 'movie' | 'tv' }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const type = body.type as 'movie' | 'tv';

    if (!type || !['movie', 'tv'].includes(type)) {
      return NextResponse.json(
        { code: 400, error: '无效的类型参数，必须是 movie 或 tv' },
        { status: 400 }
      );
    }

    const cacheKey = `douban:tags:${type}`;
    
    // 检查缓存
    const cachedTags = await cache.get<string[]>(cacheKey);
    if (cachedTags) {
      return NextResponse.json({
        code: 200,
        data: cachedTags,
        source: 'redis-cache'
      });
    }

    const tags = await doubanSearchTags(type);

    // 缓存标签（标签很少变化，可以缓存更久）
    await cache.set(cacheKey, tags, 86400); // 24小时

    return NextResponse.json({
      code: 200,
      data: tags,
      source: 'fresh',
      type
    });

  } catch (error) {
    console.error('❌ 获取搜索标签失败:', error);
    
    return NextResponse.json(
      {
        code: 500,
        error: error instanceof Error ? error.message : '获取标签失败'
      },
      { status: 500 }
    );
  }
}
