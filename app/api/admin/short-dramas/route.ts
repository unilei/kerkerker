import { NextRequest, NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/admin-route";
import { runShortDramaEntriesSync, isKkpanApiConfigured } from "@/lib/short-drama/kkpan-sync";
import { runShortDramaMetadataSync } from "@/lib/short-drama/metadata-sync";
import {
  getShortDramaSyncState,
  getShortDramaStats,
  listShortDramas,
  activeShortDramaSyncLease,
  requestShortDramaSyncCancel,
  clearStaleShortDramaSyncLease,
  deleteShortDramasByIds,
  purgeAllShortDramas,
  resetShortDramaSyncProgress,
} from "@/lib/short-drama-db";
import { isR2CoverMirrorConfigured } from "@/lib/short-drama/cover-mirror";

/**
 * 短剧数据源管理（admin）——数据来自 kkpan 公开 API。
 *
 * GET                → 同步状态 + 台账统计 + 最近条目
 * POST { action }    →
 *   entries-sync    条目同步（kkpan → 本地；全量拉取 + 下线收敛，
 *                   快速同步请求）
 *   metadata-sync   元数据同步（列 kkpan 分享目录补三件套；小批
 *                   maxItems 同步请求，全量 background=true 后台跑，
 *                   进度经 GET 轮询 running_sync 槽位展示）
 *   purge-legacy    一次性清空短剧库并复位同步统计（危险操作，确认后调用）
 *   task-cancel     取消元数据同步：活任务优雅停（进度 5 分钟内有过
 *                   更新），残留状态（进度早已停更）直接清租约
 * DELETE { ids }     → 删除本地记录（1-50 个；纯本地操作，不涉及网盘）
 */

const ALL_ACTIONS = ["entries-sync", "metadata-sync", "purge-legacy", "task-cancel"] as const;
type Action = (typeof ALL_ACTIONS)[number];

/** 活任务判定的新鲜度窗口：进度 5 分钟内有写入视为「仍在运行」 */
const PROGRESS_FRESH_MS = 5 * 60 * 1000;

function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ALL_ACTIONS as readonly string[]).includes(value);
}

/** 校验 id 数组：每项 24 位 hex、去重、上限 50 */
function parseIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^[0-9a-f]{24}$/i.test(item)) return null;
    if (!ids.includes(item)) ids.push(item);
  }
  if (ids.length === 0 || ids.length > 50) return null;
  return ids;
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(min, Math.min(Math.floor(num), max));
}

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const [state, stats, recent] = await Promise.all([
      getShortDramaSyncState(),
      getShortDramaStats(),
      listShortDramas({ limit: 20, includeOffline: true }),
    ]);
    return NextResponse.json({
      code: 200,
      message: "ok",
      data: {
        sync_state: state,
        stats,
        recent_dramas: recent.dramas,
        kkpan_api_ready: isKkpanApiConfigured(),
        cover_mirror_ready: isR2CoverMirrorConfigured(),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "读取同步状态失败",
        data: null,
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  let body: unknown = {};
  if ((request.headers.get("content-type") || "").includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { code: 400, message: "请求体必须是合法 JSON", data: null },
        { status: 400 }
      );
    }
  }
  const payload = body as {
    action?: unknown;
    maxItems?: unknown;
    background?: unknown;
  };

  if (!isAction(payload.action)) {
    return NextResponse.json(
      {
        code: 400,
        message: `action 必须是 ${ALL_ACTIONS.join(" / ")} 之一`,
        data: null,
      },
      { status: 400 }
    );
  }

  try {
    switch (payload.action) {
      case "entries-sync": {
        const stats = await runShortDramaEntriesSync();
        return NextResponse.json(
          {
            code: stats.failed ? 502 : 200,
            message: stats.error || "ok",
            data: stats,
          },
          { status: stats.failed ? 502 : 200 }
        );
      }
      case "metadata-sync": {
        const maxItems = clampInt(payload.maxItems, 0, 50_000);
        const options = maxItems !== undefined ? { maxItems } : {};

        // background=true：后台全量跑完整个队列立即返回（队列可能上千条，
        // 每条要列目录+下载三件套+R2 上传，同步请求必超时）。进度经 GET
        // 轮询 sync_state 的 running_sync 槽位展示。
        if (payload.background) {
          if (activeShortDramaSyncLease(await getShortDramaSyncState())) {
            return NextResponse.json(
              {
                code: 409,
                message: "已有元数据同步任务在运行，请等其完成再启动",
                data: null,
              },
              { status: 409 }
            );
          }
          void runShortDramaMetadataSync(options)
            .then((stats) => {
              console.log(
                "后台元数据同步结束:",
                stats.stopped_reason,
                `补齐 ${stats.attempted}、封面 ${stats.covers_mirrored}、简介 ${stats.intros_set}、metadata ${stats.metadata_set}、源缺失 ${stats.source_missing}`
              );
            })
            .catch((error) => {
              console.error("后台元数据同步异常:", error);
            });
          return NextResponse.json({
            code: 200,
            message: "ok",
            data: { started: true },
          });
        }

        const result = await runShortDramaMetadataSync(options);
        return NextResponse.json(
          { code: result.failed_fatal ? 502 : 200, message: result.error || "ok", data: result },
          { status: result.failed_fatal ? 502 : 200 }
        );
      }
      case "purge-legacy": {
        const deleted = await purgeAllShortDramas();
        await resetShortDramaSyncProgress();
        return NextResponse.json({
          code: 200,
          message: "ok",
          data: { deleted },
        });
      }
      case "task-cancel": {
        // 两种情况：
        // 1) 活任务（租约未过期且进度 5 分钟内有写入）→ 置 cancel_requested，
        //    任务循环在当前条目完成后优雅停止；
        // 2) 残留状态（进程重启/崩溃后租约还没过期，进度早已停更）→
        //    直接清租约。
        const state = await getShortDramaSyncState();
        const lease = activeShortDramaSyncLease(state);
        const progressFreshAt = lease?.progress?.updated_at
          ? new Date(lease.progress.updated_at).getTime()
          : 0;
        const progressFresh = Date.now() - progressFreshAt < PROGRESS_FRESH_MS;
        if (lease && progressFresh) {
          const requested = await requestShortDramaSyncCancel();
          return NextResponse.json({
            code: requested ? 200 : 409,
            message: requested
              ? "取消请求已发出：当前条目完成后停止"
              : "没有正在运行的任务可取消",
            data: { mode: "graceful", requested },
          }, { status: requested ? 200 : 409 });
        }
        const cleared = await clearStaleShortDramaSyncLease();
        return NextResponse.json({
          code: cleared ? 200 : 409,
          message: cleared
            ? "任务已无进程在运行：残留租约已清理"
            : "没有需要清理的任务状态",
          data: { mode: "cleared", cleared },
        }, { status: cleared ? 200 : 409 });
      }
    }
  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "任务执行失败",
        data: null,
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const unauthorized = requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  let body: unknown = {};
  if ((request.headers.get("content-type") || "").includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }
  const ids = parseIdList((body as { ids?: unknown }).ids);
  if (ids === null) {
    return NextResponse.json(
      { code: 400, message: "ids 必须是 1-50 个合法的短剧 ID 数组", data: null },
      { status: 400 }
    );
  }

  try {
    const { deleted } = await deleteShortDramasByIds(ids);
    return NextResponse.json({
      code: 200,
      message: "ok",
      data: { deleted: deleted.length },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "删除失败",
        data: null,
      },
      { status: 500 }
    );
  }
}
