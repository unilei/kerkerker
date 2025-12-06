import { NextRequest, NextResponse } from 'next/server';
import { createCache } from '@/lib/redis';
import { 
  doubanSubjectAbstract, 
  doubanSubjectSuggest,
  doubanPhotos,
  doubanComments,
  doubanRecommendations
} from '@/lib/douban-client';

// Redis 缓存配置
const cache = createCache(86400); // 缓存24小时

// 详情数据接口
interface DetailData {
  id: string;
  title: string;
  rate: string;
  url: string;
  cover: string;
  types: string[];
  release_year: string;
  directors: string[];
  actors: string[];
  duration: string;
  region: string;
  episodes_count: string;
  short_comment?: {
    content: string;
    author: string;
  };
  photos?: Array<{
    id: string;
    image: string;
    thumb: string;
  }>;
  comments?: Array<{
    id: string;
    content: string;
    author: {
      name: string;
    };
  }>;
  recommendations?: Array<{
    id: string;
    title: string;
    cover: string;
    rate: string;
  }>;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    if (!id) {
      return NextResponse.json(
        { error: '缺少豆瓣ID' },
        { status: 400 }
      );
    }

    const CACHE_KEY = `douban:detail:${id}`;
    
    // 检查 Redis 缓存
    const cachedData = await cache.get<DetailData>(CACHE_KEY);
    if (cachedData) {
      return NextResponse.json({
        ...cachedData,
        source: 'redis-cache'
      });
    }

    // 获取详情
    const detail = await doubanSubjectAbstract(id);
    
    if (!detail?.subject) {
      return NextResponse.json(
        { error: '未找到该影片信息' },
        { status: 404 }
      );
    }

    // 从标题中提取搜索关键词（移除年份和特殊字符）
    const title = detail.subject.title || '';
    const searchQuery = title
      .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '') // 移除Unicode控制字符
      .replace(/\s*[\(（]\d{4}[\)）]\s*/g, '') // 移除年份
      .split(/\s+/)[0] // 取第一部分
      .trim();

    // 并行获取额外数据：封面、剧照、短评、推荐
    const [suggestResult, photosResult, commentsResult, recommendationsResult] = await Promise.all([
      searchQuery ? doubanSubjectSuggest(searchQuery) : Promise.resolve([]),
      doubanPhotos(id, { count: 6, type: 'S' }).catch(() => []),
      doubanComments(id, { limit: 5 }).catch(() => []),
      doubanRecommendations(id).catch(() => [])
    ]);

    // 查找封面
    let cover = '';
    if (suggestResult.length > 0) {
      const matched = suggestResult.find(s => s.id === id);
      if (matched) {
        cover = matched.img || '';
      }
    }

    // 构建详情数据
    const detailData: DetailData = {
      id: detail.subject.id,
      title: detail.subject.title,
      rate: detail.subject.rate,
      url: detail.subject.url,
      cover: cover,
      types: detail.subject.types || [],
      release_year: detail.subject.release_year || '',
      directors: detail.subject.directors || [],
      actors: detail.subject.actors || [],
      duration: detail.subject.duration || '',
      region: detail.subject.region || '',
      episodes_count: detail.subject.episodes_count || '',
      short_comment: detail.subject.short_comment,
      photos: photosResult.slice(0, 6).map(p => ({
        id: p.id,
        image: p.image,
        thumb: p.thumb
      })),
      comments: commentsResult.slice(0, 5).map(c => ({
        id: c.id,
        content: c.content,
        author: c.author
      })),
      recommendations: recommendationsResult.slice(0, 6).map(r => ({
        id: r.id,
        title: r.title,
        cover: r.cover,
        rate: r.rate
      }))
    };

    // 更新 Redis 缓存
    await cache.set(CACHE_KEY, detailData);

    return NextResponse.json({
      ...detailData,
      source: 'fresh'
    });
  } catch (error) {
    console.error('获取豆瓣详情失败:', error);
    return NextResponse.json(
      { error: '获取详情失败' },
      { status: 500 }
    );
  }
}

/**
 * 清除指定影片的缓存
 * DELETE /api/douban/detail/[id]
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  if (!id) {
    return NextResponse.json(
      { error: '缺少豆瓣ID' },
      { status: 400 }
    );
  }

  const CACHE_KEY = `douban:detail:${id}`;
  await cache.del(CACHE_KEY);
  
  return NextResponse.json({
    code: 200,
    message: `影片 ${id} 的缓存已清除`
  });
}
