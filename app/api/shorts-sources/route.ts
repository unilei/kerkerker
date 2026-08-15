import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRequest } from '@/lib/admin-route';
import {
  getShortsSourcesFromDB,
  getAllShortsSourcesFromDB,
  saveShortsSourcesToDB,
  getSelectedShortsSourceFromDB,
  saveSelectedShortsSourceToDB,
} from '@/lib/shorts-sources-db';
import { ShortDramaSource } from '@/types/shorts-source';

// GET - 获取短剧视频源列表
export async function GET(request: NextRequest) {
  try {
    const unauthorizedResponse = requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { searchParams } = request.nextUrl;
    const includeDisabled = searchParams.get('all') === 'true';
    
    if (includeDisabled) {
      const allSources = await getAllShortsSourcesFromDB();
      return NextResponse.json({
        code: 200,
        message: '获取成功',
        data: allSources,
      });
    }
    
    const sources = await getShortsSourcesFromDB();
    const selectedSource = await getSelectedShortsSourceFromDB();
    
    return NextResponse.json({
      code: 200,
      message: '获取成功',
      data: {
        sources,
        selected: selectedSource,
      },
    });
  } catch (error) {
    console.error('获取短剧视频源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '获取短剧视频源失败',
        data: null,
      },
      { status: 500 }
    );
  }
}

// POST - 保存短剧视频源列表
export async function POST(request: NextRequest) {
  try {
    const unauthorizedResponse = requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await request.json();
    const { sources, selected } = body;
    
    if (!Array.isArray(sources)) {
      return NextResponse.json(
        { code: 400, message: '短剧视频源数据格式错误', data: null },
        { status: 400 }
      );
    }
    
    // 验证每个视频源的必要字段
    for (const source of sources) {
      if (!source.key || !source.name || !source.api) {
        return NextResponse.json(
          { code: 400, message: '短剧视频源缺少必要字段（key、name、api）', data: null },
          { status: 400 }
        );
      }
    }
    
    // 保存视频源
    await saveShortsSourcesToDB(sources as ShortDramaSource[]);
    
    // 保存选中的视频源
    if (selected && typeof selected === 'string') {
      await saveSelectedShortsSourceToDB(selected);
    }
    
    return NextResponse.json({
      code: 200,
      message: '保存成功',
      data: null,
    });
  } catch (error) {
    console.error('保存短剧视频源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '保存短剧视频源失败',
        data: null,
      },
      { status: 500 }
    );
  }
}

// PUT - 更新选中的短剧视频源
export async function PUT(request: NextRequest) {
  try {
    const unauthorizedResponse = requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await request.json();
    const { selected } = body;
    
    if (!selected || typeof selected !== 'string') {
      return NextResponse.json(
        { code: 400, message: '请提供选中的短剧视频源 key', data: null },
        { status: 400 }
      );
    }
    
    await saveSelectedShortsSourceToDB(selected);
    
    return NextResponse.json({
      code: 200,
      message: '更新成功',
      data: null,
    });
  } catch (error) {
    console.error('更新选中的短剧视频源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '更新失败',
        data: null,
      },
      { status: 500 }
    );
  }
}
