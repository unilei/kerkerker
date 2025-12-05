import { NextResponse } from 'next/server';
import { doubanSearchSubjects, getProxyStatus } from '@/lib/douban-client';

/**
 * 电视剧分类 API
 * GET /api/douban/tv
 * 
 * 功能：获取各类电视剧数据
 * - 热门剧集
 * - 国产剧
 * - 美剧
 * - 日剧
 * - 韩剧
 * - 英剧
 * - 综艺
 */

interface TvData {
  id: string;
  title: string;
  rate: string;
  url: string;
  cover: string;
  episode_info?: string;
}

interface CategoryData {
  name: string;
  data: TvData[];
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
    console.log('📺 开始获取电视剧分类数据...', proxyStatus.enabled ? `(代理: ${proxyStatus.count + " 个代理"})` : '');

    // 并行抓取各类电视剧数据
    const [
      hotTv,
      domestic,
      usTv,
      jpTv,
      krTv,
      ukTv,
      variety,
      anime
    ] = await Promise.all([
      fetchDoubanTv('tv', '热门'),
      fetchDoubanTv('tv', '国产剧'),
      fetchDoubanTv('tv', '美剧'),
      fetchDoubanTv('tv', '日剧'),
      fetchDoubanTv('tv', '韩剧'),
      fetchDoubanTv('tv', '英剧'),
      fetchDoubanTv('tv', '综艺'),
      fetchDoubanTv('tv', '日本动画')
    ]);

    const resultData: CategoryData[] = [
      {
        name: '热门剧集',
        data: hotTv.subjects || []
      },
      {
        name: '国产剧',
        data: domestic.subjects || []
      },
      {
        name: '美剧',
        data: usTv.subjects || []
      },
      {
        name: '日剧',
        data: jpTv.subjects || []
      },
      {
        name: '韩剧',
        data: krTv.subjects || []
      },
      {
        name: '英剧',
        data: ukTv.subjects || []
      },
      {
        name: '综艺节目',
        data: variety.subjects || []
      },
      {
        name: '日本动画',
        data: anime.subjects || []
      }
    ];

    // 更新缓存
    cacheStore = {
      data: resultData,
      timestamp: Date.now()
    };

    console.log('✅ 电视剧分类数据获取成功');

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
 * 抓取豆瓣电视剧数据
 */
async function fetchDoubanTv(type: string, tag: string) {
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
 * DELETE /api/douban/tv
 */
export async function DELETE() {
  cacheStore = null;
  
  return NextResponse.json({
    code: 200,
    message: '电视剧缓存已清除'
  });
}
