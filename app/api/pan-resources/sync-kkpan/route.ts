import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRequest } from '@/lib/admin-route';
import { getPanSyncState } from '@/lib/pan-resources-db';
import { runIncrementalSync, runBackfillSync } from '@/lib/pan/sync';

// GET - 读取 kkpans 同步状态（管理端）
export async function GET(request: NextRequest) {
  const unauthorizedResponse = requireAdminRequest(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const state = await getPanSyncState();
    return NextResponse.json({
      code: 200,
      message: '获取成功',
      data: {
        last_incremental_at: state?.last_incremental_at || null,
        last_backfill_at: state?.last_backfill_at || null,
        last_stats: state?.last_stats || null,
      },
    });
  } catch (error) {
    console.error('读取同步状态失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : '读取同步状态失败',
        data: null,
      },
      { status: 500 }
    );
  }
}

// POST - 执行同步（管理端；可被服务器 crontab 以登录 cookie 调用）
// body: { mode: "incremental" | "backfill", limit?: number }
export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdminRequest(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  let mode = 'incremental';
  let limit: number | undefined;

  try {
    const body = (await request.json()) as {
      mode?: string;
      limit?: number;
    };
    mode = body.mode || 'incremental';
    limit = body.limit;
  } catch {
    // 无 body 时按默认增量执行
  }

  if (mode !== 'incremental' && mode !== 'backfill') {
    return NextResponse.json(
      { code: 400, message: 'mode 仅支持 incremental / backfill', data: null },
      { status: 400 }
    );
  }

  try {
    const stats =
      mode === 'backfill'
        ? await runBackfillSync(limit ?? 100)
        : await runIncrementalSync(limit ?? 50);

    return NextResponse.json({
      code: 200,
      message: '同步完成',
      data: { stats },
    });
  } catch (error) {
    console.error('kkpans 同步失败:', error);
    return NextResponse.json(
      {
        code: 502,
        message: error instanceof Error ? error.message : 'kkpans 同步失败',
        data: null,
      },
      { status: 502 }
    );
  }
}
