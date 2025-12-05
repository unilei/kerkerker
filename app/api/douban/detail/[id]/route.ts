import { NextRequest, NextResponse } from 'next/server';
import { doubanSubjectAbstract, doubanSubjectSuggest } from '@/lib/douban-client';

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

    // 使用搜索建议API获取封面
    let cover = '';
    if (searchQuery) {
      const suggestions = await doubanSubjectSuggest(searchQuery);
      // 查找匹配的ID
      const matched = suggestions.find(s => s.id === id);
      if (matched) {
        cover = matched.img || '';
      }
    }

    // 返回完整数据
    return NextResponse.json({
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
    });
  } catch (error) {
    console.error('获取豆瓣详情失败:', error);
    return NextResponse.json(
      { error: '获取详情失败' },
      { status: 500 }
    );
  }
}
