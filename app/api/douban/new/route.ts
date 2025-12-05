import { NextResponse } from 'next/server';
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
const CACHE_KEY = 'douban:new:all';

/**
 * 豆瓣数据实时抓取 API
 * GET /api/douban/new
 * 
 * 特性：
 * 1. 内存缓存机制，避免频繁请求
 * 2. 实时抓取豆瓣最新数据
 * 3. 多分类数据聚合
 */
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
    console.log('🚀 开始抓取豆瓣数据...', proxyStatus.enabled ? `(代理: ${proxyStatus.count + " 个代理"})` : '');

    // 并行抓取所有分类数据
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

    const resultData: CategoryData[] = [
      {
        name: '豆瓣热映',
        data: remen.subjects || []
      },
      {
        name: '热门电视',
        data: remenTv.subjects || []
      },
      {
        name: '国产剧',
        data: guochanTV.subjects || []
      },
      {
        name: '综艺',
        data: zongyi.subjects || []
      },
      {
        name: '美剧',
        data: meiju.subjects || []
      },
      {
        name: '日剧',
        data: riju.subjects || []
      },
      {
        name: '韩剧',
        data: hanju.subjects || []
      },
      {
        name: '日本动画',
        data: ribendonghua.subjects || []
      },
      {
        name: '纪录片',
        data: jilupian.subjects || []
      }
    ];

    // 更新 Redis 缓存
    await cache.set(CACHE_KEY, resultData);

    console.log('✅ 豆瓣数据抓取成功');

    return NextResponse.json({
      code: 200,
      data: resultData,
      source: 'fresh-data',
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
 * 清除缓存接口（可选）
 * DELETE /api/douban/new
 */
export async function DELETE() {
  await cache.del(CACHE_KEY);
  
  return NextResponse.json({
    code: 200,
    message: '新上线缓存已清除'
  });
}
