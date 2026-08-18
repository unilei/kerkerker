import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  acquirePanSyncLease,
  getPanSyncState,
  releasePanSyncLease,
  renewPanSyncLease,
} from '@/lib/pan-resources-db';
import { runIncrementalSync, runBackfillSync } from '@/lib/pan/sync';
import { requirePanSyncRequest } from '@/lib/pan/sync-auth';

// GET - 读取 kkpans 同步状态（管理端）
export async function GET(request: NextRequest) {
  const unauthorizedResponse = requirePanSyncRequest(request);
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

// POST - 执行同步（管理端；可用登录 cookie 或配置的 Bearer 密钥调用）
// body: { mode: "incremental" | "backfill", limit?: number }
export async function POST(request: NextRequest) {
  const unauthorizedResponse = requirePanSyncRequest(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  let mode = 'incremental';
  let limit: number | undefined;

  // 区分空 body（合法，走默认参数）与非法 JSON（必须 400，否则会把
  // 截断或格式错误的 POST 静默当成增量同步继续写库）
  let rawBody = '';
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      { code: 400, message: '无法读取请求体', data: null },
      { status: 400 }
    );
  }

  if (rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return NextResponse.json(
          { code: 400, message: '请求体必须是 JSON 对象', data: null },
          { status: 400 }
        );
      }
      const body = parsed as {
        mode?: unknown;
        limit?: unknown;
      };
      if (body.mode !== undefined && typeof body.mode !== 'string') {
        return NextResponse.json(
          { code: 400, message: 'mode 必须是字符串', data: null },
          { status: 400 }
        );
      }
      mode = body.mode === undefined ? 'incremental' : body.mode;
      if (body.limit !== undefined) {
        if (
          typeof body.limit !== 'number' ||
          !Number.isInteger(body.limit) ||
          !Number.isFinite(body.limit)
        ) {
          return NextResponse.json(
            { code: 400, message: 'limit 必须是整数', data: null },
            { status: 400 }
          );
        }
        limit = body.limit;
      }
    } catch {
      return NextResponse.json(
        { code: 400, message: '请求体不是合法 JSON', data: null },
        { status: 400 }
      );
    }
  }

  if (mode !== 'incremental' && mode !== 'backfill') {
    return NextResponse.json(
      { code: 400, message: 'mode 仅支持 incremental / backfill', data: null },
      { status: 400 }
    );
  }

  const maxLimit = mode === 'backfill' ? 200 : 500;
  if (limit !== undefined && (limit < 1 || limit > maxLimit)) {
    return NextResponse.json(
      {
        code: 400,
        message: `limit 必须在 1 到 ${maxLimit} 之间`,
        data: null,
      },
      { status: 400 }
    );
  }

  const leaseOwner = randomUUID();
  let leaseAcquired = false;
  try {
    leaseAcquired = await acquirePanSyncLease(leaseOwner);
  } catch (error) {
    console.error('获取 kkpans 同步租约失败:', error);
    return NextResponse.json(
      { code: 502, message: '无法获取同步租约', data: null },
      { status: 502 }
    );
  }
  if (!leaseAcquired) {
    return NextResponse.json(
      { code: 409, message: '已有同步任务正在执行', data: null },
      { status: 409 }
    );
  }

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void renewPanSyncLease(leaseOwner).then((renewed) => {
      if (!renewed) leaseLost = true;
    }).catch((error) => {
      leaseLost = true;
      console.error('续租 kkpans 同步租约失败:', error);
    });
  }, 60_000);

  try {
    const stats =
      mode === 'backfill'
        ? await runBackfillSync(limit ?? 100)
        : await runIncrementalSync(limit ?? 50);

    if (leaseLost) {
      return NextResponse.json(
        { code: 409, message: '同步租约已失效，本次结果未确认', data: { stats } },
        { status: 409 }
      );
    }

    // 上游全故障（豆瓣分类 + kkpans 搜索都失败）时 sync 层会返回 failed=true，
    // 这里以 502 暴露给调用方，避免 crontab / 管理端把全量故障显示成"同步完成"。
    if (stats.failed) {
      return NextResponse.json(
        {
          code: 502,
          message: '上游服务不可用，本次未更新同步状态',
          data: { stats },
        },
        { status: 502 }
      );
    }

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
  } finally {
    clearInterval(heartbeat);
    try {
      await releasePanSyncLease(leaseOwner);
    } catch (error) {
      console.error('释放 kkpans 同步租约失败:', error);
    }
  }
}
