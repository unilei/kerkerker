import { NextRequest, NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/admin-route";
import { runShortDramaScrape, runShortDramaTagSync } from "@/lib/short-drama/scrape";
import { runShortDramaTransfer } from "@/lib/short-drama/transfer";
import { runTagGroupSync } from "@/lib/short-drama/tag-groups";
import {
  getShortDramaSyncState,
  getShortDramaStats,
  listShortDramas,
} from "@/lib/short-drama-db";
import { isR2CoverMirrorConfigured } from "@/lib/short-drama/cover-mirror";

/**
 * 短剧源管理（admin）
 *
 * GET    → 同步状态 + 台账统计 + 最近条目
 * POST   { action: "scrape-backfill" | "scrape-incremental" | "tag-sync" |
 *          "tag-group-sync" | "transfer", maxPages?, maxDetails?, maxItems? }
 *        → 同步执行对应任务并返回统计（任务有租约防并发；长任务建议
 *          由脚本/curl 携带 admin cookie 调用并轮询 GET 查看进度）
 */

const ALL_ACTIONS = [
  "scrape-backfill",
  "scrape-incremental",
  "tag-sync",
  "tag-group-sync",
  "transfer",
] as const;
type Action = (typeof ALL_ACTIONS)[number];

function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ALL_ACTIONS as readonly string[]).includes(value);
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
        const result = await runShortDramaScrape({
          mode: payload.action === "scrape-backfill" ? "backfill" : "incremental",
          ...(clampInt(payload.maxPages, 0, 5000) !== undefined
            ? { maxPages: clampInt(payload.maxPages, 0, 5000) }
            : {}),
          ...(clampInt(payload.maxDetails, 0, 100000) !== undefined
            ? { maxDetails: clampInt(payload.maxDetails, 0, 100000) }
            : {}),
        });
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
        const result = await runShortDramaTransfer(
          clampInt(payload.maxItems, 0, 500) !== undefined
            ? { maxItems: clampInt(payload.maxItems, 0, 500) }
            : {}
        );
        return NextResponse.json(
          { code: result.failed_fatal ? 502 : 200, message: result.error || "ok", data: result },
          { status: result.failed_fatal ? 502 : 200 }
        );
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
