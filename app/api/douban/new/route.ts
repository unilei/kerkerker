import { NextRequest, NextResponse } from 'next/server';
import { createCache } from '@/lib/redis';
import { doubanSearchSubjects, getProxyStatus } from '@/lib/douban-client';

interface CategoryData {
  name: string;
  data: Array<{
    id: string;
    title: string;
    rate: string;
    url: string;
    cover: string;
  }>;
}

// Redis 缓存配置
const cache = createCache(86400); // 缓存1天（秒）

/**
 * 豆瓣数据实时抓取 API
 * GET /api/douban/new
 * 
 * 支持筛选参数：
 * - type: movie | tv (类型)
 * - year: 2024, 2023, 2010年代, 90年代, 更早 (年份)
 * - region: 大陆, 美国, 韩国, 日本, 香港, 台湾... (地区)
 * - genre: 剧情, 喜剧, 动作, 爱情, 科幻... (类型)
 * - sort: recommend | time | rank (排序)
 * 
 * 特性：
 * 1. 内存缓存机制，避免频繁请求
 * 2. 实时抓取豆瓣最新数据
 * 3. 多分类数据聚合
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const type = searchParams.get('type') || '';
    const year = searchParams.get('year') || '';
    const region = searchParams.get('region') || '';
    const genre = searchParams.get('genre') || '';
    const sort = searchParams.get('sort') || 'recommend';
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = parseInt(searchParams.get('pageSize') || '30', 10);

    // 判断是否有筛选条件
    const hasFilters = type || year || region || genre;
    
    // 构建缓存键
    const cacheKey = hasFilters 
      ? `douban:new:${type}:${year}:${region}:${genre}:${sort}`
      : 'douban:new:all';

    // 检查 Redis 缓存
    const cachedData = await cache.get<CategoryData[]>(cacheKey);
    if (cachedData) {
      return NextResponse.json({
        code: 200,
        data: cachedData,
        source: 'redis-cache',
        filters: { type, year, region, genre, sort }
      });
    }

    const proxyStatus = getProxyStatus();
    console.log('🚀 开始抓取豆瓣数据...', proxyStatus.enabled ? `(代理: ${proxyStatus.count}个)` : '', hasFilters ? `筛选: ${JSON.stringify({ type, year, region, genre, sort })}` : '');

    let resultData: CategoryData[];

    if (hasFilters) {
      // 有筛选条件 - 使用标签搜索 API
      const subjects = await fetchWithTagSearch(type, year, region, genre, sort, page, pageSize);
      
      resultData = [{
        name: buildCategoryName(type, year, region, genre),
        data: subjects.data
      }];

      // 筛选结果直接返回（不缓存整体，每次请求）
      return NextResponse.json({
        code: 200,
        data: resultData,
        source: 'fresh-data',
        filters: { type, year, region, genre, sort },
        pagination: {
          page,
          pageSize,
          total: subjects.total,
          hasMore: subjects.hasMore
        }
      });
    } else {
      // 无筛选条件 - 返回默认分类
      const [
        remen,
        remenTv,
        guochanTV,
        zongyi,
        meiju,
        riju,
        hanju,
        ribendonghua,
        jilupian
      ] = await Promise.all([
        fetchDoubanData('', '热门'),
        fetchDoubanData('tv', '热门'),
        fetchDoubanData('tv', '国产剧'),
        fetchDoubanData('tv', '综艺'),
        fetchDoubanData('tv', '美剧'),
        fetchDoubanData('tv', '日剧'),
        fetchDoubanData('tv', '韩剧'),
        fetchDoubanData('tv', '日本动画'),
        fetchDoubanData('tv', '纪录片')
      ]);

      resultData = [
        { name: '豆瓣热映', data: remen.subjects || [] },
        { name: '热门电视', data: remenTv.subjects || [] },
        { name: '国产剧', data: guochanTV.subjects || [] },
        { name: '综艺', data: zongyi.subjects || [] },
        { name: '美剧', data: meiju.subjects || [] },
        { name: '日剧', data: riju.subjects || [] },
        { name: '韩剧', data: hanju.subjects || [] },
        { name: '日本动画', data: ribendonghua.subjects || [] },
        { name: '纪录片', data: jilupian.subjects || [] }
      ];
    }

    // 更新 Redis 缓存（筛选结果缓存时间短一些）
    const cacheTtl = hasFilters ? 1800 : 86400; // 筛选结果30分钟，默认1天
    await cache.set(cacheKey, resultData, cacheTtl);

    console.log('✅ 豆瓣数据抓取成功');

    return NextResponse.json({
      code: 200,
      data: resultData,
      source: 'fresh-data',
      filters: { type, year, region, genre, sort },
      totalCategories: resultData.length,
      totalItems: resultData.reduce((sum, cat) => sum + cat.data.length, 0)
    });

  } catch (error) {
    console.error('❌ 豆瓣数据抓取失败:', error);
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
 * 使用标签搜索 API 获取筛选数据（支持分页）
 * 豆瓣 search_subjects API 使用 tag 参数进行筛选
 */
async function fetchWithTagSearch(
  type: string,
  year: string,
  region: string,
  genre: string,
  sort: string,
  page: number,
  pageSize: number
): Promise<{ data: Array<{ id: string; title: string; rate: string; url: string; cover: string }>; total: number; hasMore: boolean }> {
  try {
    // 构建搜索标签 - 豆瓣 API 使用单个 tag 参数
    // 优先级: 类型 > 地区 > 年份 > 排序相关标签
    let tag = '热门';  // 默认标签
    const searchType = type === 'tv' ? 'tv' : 'movie';
    
    // 根据筛选条件选择最合适的标签
    if (genre) {
      tag = genre;
    } else if (region) {
      // 地区作为标签
      const regionTagMap: Record<string, string> = {
        '大陆': '国产',
        '香港': '港剧',
        '台湾': '台剧',
        '美国': '美剧',
        '韩国': '韩剧',
        '日本': '日剧',
        '英国': '英剧',
      };
      tag = (searchType === 'tv' ? regionTagMap[region] : region) || region;
    } else if (year) {
      // 年份作为标签
      tag = year;
    } else if (sort === 'rank') {
      tag = '高分';
    } else if (sort === 'time') {
      tag = '最新';
    }

    const start = (page - 1) * pageSize;
    
    const data = await doubanSearchSubjects({
      type: searchType,
      tag,
      page_limit: pageSize,
      page_start: start
    });
    
    const subjects = data.subjects || [];
    console.log(`✓ 标签搜索成功: tag=${tag}, type=${searchType} (${subjects.length}条)`);
    
    return {
      data: subjects.map(item => ({
        id: item.id,
        title: item.title,
        rate: item.rate || '',
        url: item.url || `https://movie.douban.com/subject/${item.id}/`,
        cover: item.cover || '',
      })),
      total: subjects.length >= pageSize ? (page * pageSize + pageSize) : (page - 1) * pageSize + subjects.length,
      hasMore: subjects.length >= pageSize
    };
  } catch (error) {
    console.error('✗ 标签搜索失败:', error);
    return { data: [], total: 0, hasMore: false };
  }
}

/**
 * 构建分类名称
 */
function buildCategoryName(type: string, year: string, region: string, genre: string): string {
  const parts: string[] = [];
  
  if (year) parts.push(year);
  if (region) parts.push(region);
  if (genre) parts.push(genre);
  if (type === 'movie') parts.push('电影');
  else if (type === 'tv') parts.push('电视剧');
  
  return parts.length > 0 ? parts.join(' · ') : '热门';
}

/**
 * 抓取豆瓣分类数据
 */
async function fetchDoubanData(type: string, tag: string) {
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
 * DELETE /api/douban/new
 */
export async function DELETE() {
  // 清除默认缓存
  await cache.del('douban:new:all');
  
  return NextResponse.json({
    code: 200,
    message: '新上线缓存已清除（筛选缓存将自动过期）'
  });
}
