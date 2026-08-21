import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  acquirePanSyncLease,
  renewPanSyncLease,
  releasePanSyncLease,
} from "@/lib/pan-resources-db";
import { requirePanSyncRequest } from "@/lib/pan/sync-auth";
import {
  PAN_SYNC_TARGET_STATUSES,
  discoverAndEnqueuePanSyncTargets,
  getPanSyncTarget,
  listPanSyncTargets,
  queueDuePanSyncTargets,
  resetPanSyncTarget,
  runPanSyncTargetBatch,
  type PanSyncTargetStatus,
} from "@/lib/pan/catalog-sync";
import {
  findContentIdentityById,
  isValidContentId,
} from "@/lib/content-identity-db";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";

function badRequest(message: string) {
  return NextResponse.json(
    { code: 400, message, data: null },
    { status: 400 }
  );
}

function validStatus(value: string | null): value is PanSyncTargetStatus {
  return value != null && (PAN_SYNC_TARGET_STATUSES as readonly string[]).includes(value);
}

export async function GET(request: NextRequest) {
  const unauthorizedResponse = requirePanSyncRequest(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const params = request.nextUrl.searchParams;
  const statusParam = params.get("status");
  if (statusParam && statusParam !== "all" && !validStatus(statusParam)) {
    return badRequest("无效的同步状态");
  }
  const page = Number(params.get("page") || 1);
  const limit = Number(params.get("limit") || 20);
  if (!Number.isInteger(page) || page < 1) return badRequest("page 必须是正整数");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return badRequest("limit 必须在 1 到 100 之间");
  }

  try {
    const result = await listPanSyncTargets({
      status:
        statusParam && statusParam !== "all"
          ? (statusParam as PanSyncTargetStatus)
          : undefined,
      keyword: params.get("keyword") || undefined,
      page,
      limit,
    });
    return NextResponse.json({ code: 200, message: "获取成功", data: result });
  } catch (error) {
    console.error("读取影片同步台账失败:", error);
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "读取同步台账失败",
        data: null,
      },
      { status: 500 }
    );
  }
}

async function parseBody(request: NextRequest): Promise<{
  action: string;
  limit: number;
  doubanId?: string;
  contentId?: string;
} | null> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  if (!raw.trim()) return { action: "run", limit: 5 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;
  const action = body.action === undefined ? "run" : body.action;
  const limit = body.limit === undefined ? 5 : body.limit;
  if (typeof action !== "string") return null;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit)) return null;
  const doubanId = body.douban_id;
  if (doubanId !== undefined && typeof doubanId !== "string") return null;
  const contentId = body.content_id;
  if (contentId !== undefined && typeof contentId !== "string") return null;
  return {
    action,
    limit,
    doubanId: typeof doubanId === "string" ? doubanId.trim() : undefined,
    contentId: typeof contentId === "string" ? contentId.trim() : undefined,
  };
}

async function resolveTargetDoubanId(input: {
  doubanId?: string;
  contentId?: string;
}): Promise<string | undefined> {
  if (!input.contentId) return input.doubanId;
  if (!isValidContentId(input.contentId)) {
    throw new RangeError("content_id 格式无效");
  }
  const identity = await findContentIdentityById(input.contentId);
  if (!identity) throw new RangeError("content_id 尚未解析为宿主内容身份");
  const doubanRefs = identity.externalRefs.filter(
    (ref) =>
      ref.providerId === DOUBAN_CONTENT_PLUGIN_ID &&
      /^\d{1,20}$/.test(ref.externalId)
  );
  const matchingRef = input.doubanId
    ? doubanRefs.find((ref) => ref.externalId === input.doubanId)
    : doubanRefs.length === 1
      ? doubanRefs[0]
      : undefined;
  if (!matchingRef) {
    throw new RangeError("content_id 与 douban_id 的宿主身份不一致");
  }
  return matchingRef.externalId;
}

async function withSyncLease<T>(
  work: (owner: string) => Promise<T>
): Promise<T | NextResponse> {
  const owner = randomUUID();
  // 发现目录和单片搜索都可能超过默认 5 分钟租期；用较长初始租期并
  // 定期续租，避免长任务被另一请求抢走后出现游标/状态互相覆盖。
  if (!(await acquirePanSyncLease(owner, 25 * 60 * 1000))) {
    return NextResponse.json(
      { code: 409, message: "已有同步任务正在执行", data: null },
      { status: 409 }
    );
  }
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void renewPanSyncLease(owner)
      .then((renewed) => {
        if (!renewed) leaseLost = true;
      })
      .catch((error) => {
        leaseLost = true;
        console.error("续租影片同步租约失败:", error);
      });
  }, 60_000);
  try {
    const result = await work(owner);
    if (leaseLost) {
      return NextResponse.json(
        { code: 409, message: "同步租约已失效，本次结果未确认", data: null },
        { status: 409 }
      );
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    await releasePanSyncLease(owner).catch((error) => {
      console.error("释放影片同步租约失败:", error);
    });
  }
}

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requirePanSyncRequest(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const body = await parseBody(request);
  if (!body) return badRequest("请求体必须是合法 JSON 对象");
  if (!["discover", "run", "sync", "retry", "daily"].includes(body.action)) {
    return badRequest("action 仅支持 discover / run / sync / retry / daily");
  }
  if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 20) {
    return badRequest("limit 必须在 1 到 20 之间");
  }
  if (["sync", "retry"].includes(body.action) && !body.doubanId) {
    if (!body.contentId) return badRequest("该操作需要 douban_id 或 content_id");
  }
  if (body.doubanId && !/^\d{1,20}$/.test(body.doubanId)) {
    return badRequest("douban_id 必须是数字 ID");
  }
  if (body.contentId && !isValidContentId(body.contentId)) {
    return badRequest("content_id 格式无效");
  }

  try {
    const targetDoubanId = await resolveTargetDoubanId(body);
    if (body.action === "discover") {
      const result = await withSyncLease(async () => {
        const discovery = await discoverAndEnqueuePanSyncTargets();
        const status = await listPanSyncTargets({ page: 1, limit: 1 });
        if (discovery.discovered === 0 && discovery.sourceErrors.length > 0) {
          return NextResponse.json(
            {
              code: 502,
              message: "无法发现站内影片目录",
              data: { ...discovery, stats: status.stats },
            },
            { status: 502 }
          );
        }
        return NextResponse.json({
          code: 200,
          message: "影片目录发现完成",
          data: { ...discovery, stats: status.stats },
        });
      });
      return result;
    }

    if (body.action === "retry" && targetDoubanId) {
      const reset = await resetPanSyncTarget(targetDoubanId);
      if (!reset) return NextResponse.json(
        { code: 404, message: "影片不在同步台账中", data: null },
        { status: 404 }
      );
      return NextResponse.json({
        code: 200,
        message: "已加入待同步队列",
        data: { target: await getPanSyncTarget(targetDoubanId) },
      });
    }

    const result = await withSyncLease(async (owner) => {
      let discovery:
        | Awaited<ReturnType<typeof discoverAndEnqueuePanSyncTargets>>
        | undefined;
      if (body.action === "sync" && targetDoubanId) {
        const reset = await resetPanSyncTarget(targetDoubanId);
        if (!reset) {
          return NextResponse.json(
            { code: 404, message: "影片不在同步台账中，请先发现目录", data: null },
            { status: 404 }
          );
        }
      }
      if (body.action === "daily") {
        discovery = await discoverAndEnqueuePanSyncTargets();
        await queueDuePanSyncTargets();
      }
      const batch = await runPanSyncTargetBatch(
        body.action === "sync" ? 1 : body.limit,
        owner,
        body.action === "sync" ? targetDoubanId : undefined
      );
      return NextResponse.json({
        code: 200,
        message: body.action === "sync" ? "影片同步完成" : "影片同步批次完成",
        data: discovery ? { ...batch, discovery } : batch,
      });
    });
    return result;
  } catch (error) {
    console.error("执行影片同步任务失败:", error);
    const status = error instanceof RangeError ? 400 : 502;
    return NextResponse.json(
      {
        code: status,
        message: error instanceof Error ? error.message : "影片同步任务失败",
        data: null,
      },
      { status }
    );
  }
}
