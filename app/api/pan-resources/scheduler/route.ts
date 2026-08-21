import { NextRequest, NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/admin-route";
import {
  PAN_SYNC_TASKS,
  PanSyncSchedulerBusyError,
  enqueuePanSyncRun,
  getPanSyncSchedulerDashboard,
  requestPanSyncRunCancel,
  startPanSyncScheduler,
  updatePanSyncSchedule,
  type PanSyncSchedulePatch,
  type PanSyncTask,
} from "@/lib/pan/scheduler";
import { adaptPanSyncRunsToPluginJobRuns } from "@/lib/pan/job-runner-adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(message: string) {
  return NextResponse.json({ code: 400, message, data: null }, { status: 400 });
}

function isTask(value: unknown): value is PanSyncTask {
  return typeof value === "string" && (PAN_SYNC_TASKS as readonly string[]).includes(value);
}

function parsePositiveInteger(value: string | null, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new RangeError(`limit 必须在 1 到 ${max} 之间`);
  }
  return parsed;
}

async function parseBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  let raw: string;
  try { raw = await request.text(); } catch { return null; }
  if (!raw.trim()) return {};
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch { return null; }
}

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  startPanSyncScheduler();
  const taskParam = request.nextUrl.searchParams.get("task");
  if (taskParam && !isTask(taskParam)) return badRequest("task 仅支持 catalog / incremental");
  const runId = request.nextUrl.searchParams.get("run_id")?.trim();
  if (runId && !/^[A-Za-z0-9-]{1,100}$/.test(runId)) return badRequest("run_id 无效");
  let limit: number;
  try { limit = parsePositiveInteger(request.nextUrl.searchParams.get("limit"), 20, 100); }
  catch (error) { return badRequest(error instanceof Error ? error.message : "limit 无效"); }
  try {
    const dashboard = await getPanSyncSchedulerDashboard({
      task: taskParam as PanSyncTask | undefined,
      runId: runId || undefined,
      limit,
    });
    // The legacy scheduler remains the write-side source of truth. Expose a
    // read-only provider-neutral view for the future job center without
    // widening or renaming the existing `runs`/`active_run` API fields.
    return NextResponse.json({
      code: 200,
      message: "获取成功",
      data: {
        ...dashboard,
        plugin_runs: adaptPanSyncRunsToPluginJobRuns(dashboard.runs),
        active_plugin_run: dashboard.active_run
          ? adaptPanSyncRunsToPluginJobRuns([dashboard.active_run])[0]
          : null,
      },
    });
  } catch (error) {
    console.error("读取后台同步调度状态失败:", error);
    return NextResponse.json({ code: 500, message: error instanceof Error ? error.message : "读取调度状态失败", data: null }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdminRequest(request);
  if (unauthorized) return unauthorized;
  startPanSyncScheduler();
  const body = await parseBody(request);
  if (!body) return badRequest("请求体必须是合法 JSON 对象");
  const action = body.action;
  if (typeof action !== "string") return badRequest("缺少 action");
  try {
    if (action === "configure") {
      if (!isTask(body.task)) return badRequest("task 仅支持 catalog / incremental");
      const patch: PanSyncSchedulePatch = {};
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return badRequest("enabled 必须是布尔值");
        patch.enabled = body.enabled;
      }
      if (body.time !== undefined) {
        if (typeof body.time !== "string" || !/^\d{2}:\d{2}$/.test(body.time)) return badRequest("time 必须是 HH:mm 格式");
        const [hour, minute] = body.time.split(":").map(Number);
        patch.hour = hour; patch.minute = minute;
      }
      if (body.timezone !== undefined) {
        if (typeof body.timezone !== "string" || body.timezone.length > 100) return badRequest("timezone 无效");
        patch.timezone = body.timezone;
      }
      for (const key of ["batch_limit", "max_batches"] as const) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== "number" || !Number.isSafeInteger(body[key])) return badRequest(`${key} 必须是整数`);
          patch[key] = body[key];
        }
      }
      const schedule = await updatePanSyncSchedule(body.task, patch);
      return NextResponse.json({ code: 200, message: "调度配置已保存", data: { schedule } });
    }
    if (action === "run_now") {
      if (!isTask(body.task)) return badRequest("task 仅支持 catalog / incremental");
      const batchLimit = body.batch_limit;
      const maxBatches = body.max_batches;
      if (batchLimit !== undefined && (typeof batchLimit !== "number" || !Number.isSafeInteger(batchLimit))) return badRequest("batch_limit 必须是整数");
      if (maxBatches !== undefined && (typeof maxBatches !== "number" || !Number.isSafeInteger(maxBatches))) return badRequest("max_batches 必须是整数");
      const run = await enqueuePanSyncRun({ task: body.task, batchLimit: batchLimit as number | undefined, maxBatches: maxBatches as number | undefined });
      return NextResponse.json({ code: 200, message: "任务已启动", data: { run } }, { status: 202 });
    }
    if (action === "cancel") {
      const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
      if (!/^[A-Za-z0-9-]{1,100}$/.test(runId)) return badRequest("run_id 无效");
      const cancelled = await requestPanSyncRunCancel(runId);
      if (!cancelled) return NextResponse.json({ code: 404, message: "任务不存在或已经结束", data: null }, { status: 404 });
      return NextResponse.json({ code: 200, message: "已请求停止任务", data: { run_id: runId } });
    }
    return badRequest("action 仅支持 configure / run_now / cancel");
  } catch (error) {
    if (error instanceof PanSyncSchedulerBusyError) return NextResponse.json({ code: 409, message: error.message, data: null }, { status: 409 });
    const status = error instanceof RangeError ? 400 : 502;
    console.error("更新后台同步调度失败:", error);
    return NextResponse.json({ code: status, message: error instanceof Error ? error.message : "更新调度失败", data: null }, { status });
  }
}
