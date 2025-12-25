import { NextRequest, NextResponse } from 'next/server';
import {
  getVodSourcesFromDB,
  getAllVodSourcesFromDB,
  saveVodSourcesToDB,
  getSelectedVodSourceFromDB,
  saveSelectedVodSourceToDB,
} from '@/lib/vod-sources-db';
import { VodSource } from '@/types/drama';

// GET - 获取视频源列表
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const includeDisabled = searchParams.get('all') === 'true';
    
    if (includeDisabled) {
      const allSources = await getAllVodSourcesFromDB();
      return NextResponse.json({
        code: 200,
        message: '获取成功',
        data: allSources,
      });
    }
    
    const sources = await getVodSourcesFromDB();
    const selectedSource = await getSelectedVodSourceFromDB();
    
    return NextResponse.json({
      code: 200,
      message: '获取成功',
      data: {
        sources,
        selected: selectedSource,
      },
    });
  } catch (error) {
    console.error('获取视频源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '获取视频源失败',
        data: null,
      },
      { status: 500 }
    );
  }
}

// POST - 保存视频源列表
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sources, selected } = body;
    
    if (!Array.isArray(sources)) {
      return NextResponse.json(
        { code: 400, message: '视频源数据格式错误', data: null },
        { status: 400 }
      );
    }
    
    // 验证每个视频源的必要字段（playUrl 是可选的）
    for (const source of sources) {
      if (!source.key || !source.name || !source.api || !source.type) {
        return NextResponse.json(
          { code: 400, message: '视频源缺少必要字段（key、name、api、type）', data: null },
          { status: 400 }
        );
      }
    }
    
    // 保存视频源
    await saveVodSourcesToDB(sources as VodSource[]);
    
    // 保存选中的视频源
    if (selected && typeof selected === 'string') {
      await saveSelectedVodSourceToDB(selected);
    }
    
    return NextResponse.json({
      code: 200,
      message: '保存成功',
      data: null,
    });
  } catch (error) {
    console.error('保存视频源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '保存视频源失败',
        data: null,
      },
      { status: 500 }
    );
  }
}

// PUT - 更新选中的视频源
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { selected } = body;
    
    if (!selected || typeof selected !== 'string') {
      return NextResponse.json(
        { code: 400, message: '请提供选中的视频源 key', data: null },
        { status: 400 }
      );
    }
    
    await saveSelectedVodSourceToDB(selected);
    
    return NextResponse.json({
      code: 200,
      message: '更新成功',
      data: null,
    });
  } catch (error) {
    console.error('更新选中的视频源失败:', error);
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
