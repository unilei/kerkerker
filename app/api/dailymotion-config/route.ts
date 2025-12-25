import { NextRequest, NextResponse } from 'next/server';
import {
  getDailymotionConfigFromDB,
  addDailymotionChannelToDB,
  updateDailymotionChannelInDB,
  deleteDailymotionChannelFromDB,
  setDefaultDailymotionChannelInDB,
} from '@/lib/dailymotion-config-db';

// GET - 获取所有频道配置（带 Redis 缓存）
export async function GET() {
  try {
    const config = await getDailymotionConfigFromDB();
    return NextResponse.json({
      code: 200,
      message: 'Success',
      data: config,
    });
  } catch (error) {
    console.error('❌ 获取 Dailymotion 配置失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : 'Failed to read config',
        data: null,
      },
      { status: 500 }
    );
  }
}

// POST - 更新配置（使用 MongoDB + Redis 缓存）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.action === 'add') {
      // 添加新频道
      await addDailymotionChannelToDB(
        body.username,
        body.displayName,
        body.avatarUrl
      );
    } else if (body.action === 'update') {
      // 更新频道
      const updates: {
        username?: string;
        displayName?: string;
        avatarUrl?: string;
        isActive?: boolean;
      } = {};
      if (body.username !== undefined) updates.username = body.username;
      if (body.displayName !== undefined) updates.displayName = body.displayName;
      if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
      if (body.isActive !== undefined) updates.isActive = body.isActive;
      
      await updateDailymotionChannelInDB(body.id, updates);
    } else if (body.action === 'delete') {
      // 删除频道
      await deleteDailymotionChannelFromDB(body.id);
    } else if (body.action === 'setDefault') {
      // 设置默认频道
      await setDefaultDailymotionChannelInDB(body.id);
    } else {
      return NextResponse.json(
        {
          code: 400,
          message: 'Invalid action',
          data: null,
        },
        { status: 400 }
      );
    }

    // 返回更新后的配置
    const config = await getDailymotionConfigFromDB();

    return NextResponse.json({
      code: 200,
      message: 'Success',
      data: config,
    });
  } catch (error) {
    console.error('❌ 更新 Dailymotion 配置失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : 'Failed to update config',
        data: null,
      },
      { status: 500 }
    );
  }
}
