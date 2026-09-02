import { NextRequest, NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/admin-route";
import { runShortDramaScrape, runShortDramaTagSync } from "@/lib/short-drama/scrape";
import {
  runShortDramaTransfer,
  runShortDramaMetadataBackfill,
  runShortDramaDeletion,
} from "@/lib/short-drama/transfer";
import { runTagGroupSync } from "@/lib/short-drama/tag-groups";
import {
  getShortDramaSyncState,
  getShortDramaStats,
  listShortDramas,
  activeShortDramaLease,
  requestShortDramaTaskCancel,
  clearStaleShortDramaLease,
} from "@/lib/short-drama-db";
import type { ShortDramaStatus } from "@/types/short-drama";
import { isR2CoverMirrorConfigured } from "@/lib/short-drama/cover-mirror";

/**
 * 短剧源管理（admin）
 *
 * GET                → 同步状态 + 台账统计 + 最近条目
 * GET  view=queue    → 待转存列表（status=discovered,failed 可选、
 *                      search、page、limit；含发布日期便于排序展示）
 * POST   { action: "scrape-backfill" | "scrape-incremental" | "tag-sync" |
 *          "tag-group-sync" | "transfer" | "metadata-backfill", maxPages?,
 *          maxDetails?, maxItems?, startPage?, ids?, background? }
 *        → 同步执行对应任务并返回统计（任务有租约防并发；长任务建议
 *          由脚本/curl 携带 admin cookie 调用并轮询 GET 查看进度）。
 *          transfer 支持 ids（后台单个/批量转存指定条目）；
 *          scrape/transfer/metadata-backfill 支持 background=true（立即
 *          返回，后台执行；metadata-backfill 缺省跑完整个补齐队列），
 *          进度经 GET 轮询 sync_state 的 running_scrape/running_transfer
 *          槽位展示。抓取与转存租约独立、可并行；同类任务互斥。
 * DELETE { ids }     → 删除短剧：先删自己夸克网盘的转存目录（分享随之
 *          失效），网盘清理成功才删本地记录；网盘失败保留记录可重试。
 */

const ALL_ACTIONS = [
  "scrape-backfill",
  "scrape-incremental",
  "tag-sync",
  "tag-group-sync",
  "transfer",
  "metadata-backfill",
  "task-cancel",
] as const;
type Action = (typeof ALL_ACTIONS)[number];

const QUEUE_STATUSES: ShortDramaStatus[] = ["discovered", "failed", "transferring"];

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

  // 待转存列表视图：discovered + failed（可选含 transferring），按发布
  // 日期新→旧（与抓取顺序一致），供后台逐条/批量操作
  if (request.nextUrl.searchParams.get("view") === "queue") {
    try {
      const params = request.nextUrl.searchParams;
      const statusFilter = (params.get("status") || "")
        .split(",")
        .map((item) => item.trim())
        .filter((item): item is ShortDramaStatus =>
          (QUEUE_STATUSES as string[]).includes(item)
        );
      const result = await listShortDramas({
        statuses: statusFilter.length > 0 ? statusFilter : ["discovered", "failed"],
        includeDisabled: true,
        ...(params.get("search") ? { search: params.get("search") || undefined } : {}),
        page: Number(params.get("page")) || 1,
        limit: Math.min(Number(params.get("limit")) || 30, 100),
      });
      return NextResponse.json({
        code: 200,
        message: "ok",
        data: {
          dramas: result.dramas.map((drama) => ({
            id: drama.id,
            title: drama.title,
            episode_count: drama.episode_count,
            status: drama.status,
            publish_date: drama.publish_date,
            source_share_url: drama.source_share_url,
            source_article_id: drama.source_article_id,
            transfer_error: drama.transfer_error,
            transfer_attempts: drama.transfer_attempts,
            created_at: drama.created_at,
          })),
          total: result.total,
          page: result.page,
          limit: result.limit,
        },
      });
    } catch (error) {
      return NextResponse.json(
        {
          code: 500,
          message: error instanceof Error ? error.message : "待转存列表读取失败",
          data: null,
        },
        { status: 500 }
      );
    }
  }

  try {
    const [state, stats, recent] = await Promise.all([
      getShortDramaSyncState(),
      getShortDramaStats(),
      listShortDramas({ limit: 20, includeDisabled: true }),
    ]);
    return NextResponse.json({
      code: 200,
      message: "ok",
      data: {
        sync_state: state,
        stats,
        recent_dramas: recent.dramas,
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
    maxPages?: unknown;
    maxDetails?: unknown;
    maxItems?: unknown;
    startPage?: unknown;
    endPage?: unknown;
    search?: unknown;
    status?: unknown;
    ids?: unknown;
    background?: unknown;
    target?: unknown;
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
      case "scrape-backfill":
      case "scrape-incremental": {
        const scrapeOptions = {
          mode: payload.action === "scrape-backfill" ? ("backfill" as const) : ("incremental" as const),
          ...(clampInt(payload.maxPages, 0, 5000) !== undefined
            ? { maxPages: clampInt(payload.maxPages, 0, 5000) }
            : {}),
          ...(clampInt(payload.maxDetails, 0, 100000) !== undefined
            ? { maxDetails: clampInt(payload.maxDetails, 0, 100000) }
            : {}),
          ...(clampInt(payload.startPage, 0, 100000) !== undefined
            ? { startPage: clampInt(payload.startPage, 0, 100000) }
            : {}),
        };

        // background=true：启动后台任务立即返回（全量回填要跑数小时，
        // 不能挂着一个同步请求等它）。进度经 GET 轮询 sync_state 的
        // running_scrape/running_transfer 槽位展示；租约保证重复点击/
        // 并发启动不会重复抓（抓取与转存可并行，同类任务互斥）。
        if (payload.background) {
          if (activeShortDramaLease(await getShortDramaSyncState(), "scrape")) {
            return NextResponse.json(
              {
                code: 409,
                message: "已有抓取类任务在运行（抓取/标签），请等其完成再启动",
                data: null,
              },
              { status: 409 }
            );
          }
          void runShortDramaScrape(scrapeOptions)
            .then((stats) => {
              console.log(
                `后台短剧抓取结束（${scrapeOptions.mode}）:`,
                stats.stopped_reason,
                `新建 ${stats.items_created}、更新 ${stats.items_updated}、失败页 ${stats.failed_pages}`
              );
            })
            .catch((error) => {
              console.error("后台短剧抓取异常:", error);
            });
          return NextResponse.json({
            code: 200,
            message: "ok",
            data: { started: true, mode: scrapeOptions.mode },
          });
        }

        const result = await runShortDramaScrape(scrapeOptions);
        return NextResponse.json(
          { code: result.failed ? 502 : 200, message: result.error || "ok", data: result },
          { status: result.failed ? 502 : 200 }
        );
      }
      case "tag-sync": {
        const result = await runShortDramaTagSync({});
        return NextResponse.json(
          { code: result.failed ? 502 : 200, message: result.error || "ok", data: result },
          { status: result.failed ? 502 : 200 }
        );
      }
      case "tag-group-sync": {
        const result = await runTagGroupSync();
        return NextResponse.json(
          { code: 200, message: result.error || "ok", data: result },
          { status: 200 }
        );
      }
      case "transfer": {
        const ids =
          payload.ids !== undefined ? parseIdList(payload.ids) : undefined;
        if (payload.ids !== undefined && ids === null) {
          return NextResponse.json(
            {
              code: 400,
              message: "ids 必须是 1-50 个合法的短剧 ID 数组",
              data: null,
            },
            { status: 400 }
          );
        }

        // 页码范围转存（与待转存 Tab 同一套分页：发布日期新→旧，30 条/页，
        // 叠加 search/status 筛选）；必须 background 启动（几百部要跑数小时）
        const startPage = clampInt(payload.startPage, 1, 100000);
        const endPage = clampInt(payload.endPage, 1, 100000);
        let queuePages: {
          start: number;
          end: number;
          search?: string;
          statuses?: ShortDramaStatus[];
        } | undefined;
        if (startPage !== undefined) {
          const search =
            typeof payload.search === "string" && payload.search.trim()
              ? payload.search.trim().slice(0, 100)
              : undefined;
          const statusFilter = (typeof payload.status === "string" ? payload.status : "")
            .split(",")
            .map((item) => item.trim())
            .filter((item): item is ShortDramaStatus =>
              (QUEUE_STATUSES as string[]).includes(item)
            );
          queuePages = {
            start: startPage,
            end: endPage ?? startPage,
            ...(search ? { search } : {}),
            ...(statusFilter.length > 0 ? { statuses: statusFilter } : {}),
          };
        } else if (endPage !== undefined) {
          return NextResponse.json(
            { code: 400, message: "endPage 需要搭配 startPage 使用", data: null },
            { status: 400 }
          );
        }

        if (queuePages && !payload.background) {
          return NextResponse.json(
            {
              code: 400,
              message: "范围转存耗时较长，必须 background=true 后台启动",
              data: null,
            },
            { status: 400 }
          );
        }

        if (payload.background) {
          if (activeShortDramaLease(await getShortDramaSyncState(), "transfer")) {
            return NextResponse.json(
              {
                code: 409,
                message: "已有转存类任务在运行（转存/补齐/删除），请等其完成再启动",
                data: null,
              },
              { status: 409 }
            );
          }
          void runShortDramaTransfer({
            ...(ids ? { ids } : {}),
            ...(queuePages ? { queuePages } : {}),
          })
            .then((stats) => {
              console.log(
                "后台批量转存结束:",
                stats.stopped_reason,
                `成功 ${stats.succeeded}、失败 ${stats.failed}、封面 ${stats.covers_mirrored}`
              );
            })
            .catch((error) => {
              console.error("后台批量转存异常:", error);
            });
          return NextResponse.json({
            code: 200,
            message: "ok",
            data: { started: true, queued: ids?.length ?? undefined },
          });
        }

        const result = await runShortDramaTransfer(
          ids
            ? { ids }
            : clampInt(payload.maxItems, 0, 500) !== undefined
              ? { maxItems: clampInt(payload.maxItems, 0, 500) }
              : {}
        );
        return NextResponse.json(
          { code: result.failed_fatal ? 502 : 200, message: result.error || "ok", data: result },
          { status: result.failed_fatal ? 502 : 200 }
        );
      }
      case "metadata-backfill": {
        const maxItems = clampInt(payload.maxItems, 0, 50_000);
        const backfillOptions = maxItems !== undefined ? { maxItems } : {};

        // background=true：后台全量跑完整个队列立即返回（队列可上百条，
        // 每条要列目录+下载三件套+R2 上传，同步请求必超时）。补齐与转存
        // 同用 transfer 租约互斥，进度经 GET 轮询 running_transfer 展示。
        if (payload.background) {
          if (activeShortDramaLease(await getShortDramaSyncState(), "transfer")) {
            return NextResponse.json(
              {
                code: 409,
                message: "已有转存类任务在运行（转存/补齐/删除），请等其完成再启动",
                data: null,
              },
              { status: 409 }
            );
          }
          void runShortDramaMetadataBackfill(backfillOptions)
            .then((stats) => {
              console.log(
                "后台元数据补齐结束:",
                stats.stopped_reason,
                `补齐 ${stats.attempted}、封面 ${stats.covers_mirrored}、简介 ${stats.intros_set}、metadata ${stats.metadata_set}、源缺失 ${stats.source_missing}`
              );
            })
            .catch((error) => {
              console.error("后台元数据补齐异常:", error);
            });
          return NextResponse.json({
            code: 200,
            message: "ok",
            data: { started: true },
          });
        }

        const result = await runShortDramaMetadataBackfill(backfillOptions);
        return NextResponse.json(
          { code: result.failed_fatal ? 502 : 200, message: result.error || "ok", data: result },
          { status: result.failed_fatal ? 502 : 200 }
        );
      }
      case "task-cancel": {
        // 两种情况：
        // 1) 活任务（租约未过期且进度 5 分钟内有写入）→ 置 cancel_requested，
        //    任务循环在当前条目完成后优雅停止；
        // 2) 残留状态（进程重启/崩溃后租约还没过期，进度早已停更）→
        //    直接清租约并复位卡在 transferring 的条目。
        const task = payload.target === "scrape" ? "scrape" : "transfer";
        const state = await getShortDramaSyncState();
        const lease = activeShortDramaLease(state, task);
        const progressFreshAt = lease?.progress?.updated_at
          ? new Date(lease.progress.updated_at).getTime()
          : 0;
        const progressFresh = Date.now() - progressFreshAt < 5 * 60 * 1000;
        if (lease && progressFresh) {
          const requested = await requestShortDramaTaskCancel(task);
          return NextResponse.json({
            code: requested ? 200 : 409,
            message: requested
              ? "取消请求已发出：当前条目完成后停止"
              : "没有正在运行的任务可取消",
            data: { mode: "graceful", requested, task },
          }, { status: requested ? 200 : 409 });
        }
        const cleared = await clearStaleShortDramaLease(task);
        return NextResponse.json({
          code: cleared ? 200 : 409,
          message: cleared
            ? "任务已无进程在运行：残留租约已清理，卡住的条目已复位"
            : "没有需要清理的任务状态",
          data: { mode: "cleared", cleared, task },
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
    const result = await runShortDramaDeletion(ids);
    const failed = result.failed_fatal || result.failed > 0;
    return NextResponse.json(
      {
        code: failed ? (result.failed_fatal ? 502 : 207) : 200,
        message: result.error || (result.failed > 0 ? "部分删除失败" : "ok"),
        data: result,
      },
      { status: failed ? (result.failed_fatal ? 502 : 207) : 200 }
    );
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
