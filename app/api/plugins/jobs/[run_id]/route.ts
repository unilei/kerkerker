import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import { recordAudit, type AuditEventInput } from "@/lib/compliance-db";
import {
  adminAuditActor,
  requestAuditId,
} from "@/lib/compliance-route";
import {
  getMongoPluginJobStore,
} from "@/lib/plugins/mongo-job-store";
import {
  LEGACY_EXTERNAL_REPORT_JOB_ID,
  PluginJobError,
  PluginJobRunner,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobRun,
  type PluginJobRunnerPort,
} from "@/lib/plugins/job-runner";
import {
  redactPluginJobEventError,
  redactPluginJobEventText,
} from "@/lib/plugins/job-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RUN_ID_LENGTH = 200;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REASON_LENGTH = 2_000;
const LIFECYCLE_ACTIONS = ["cancel", "retry"] as const;
type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

class InvalidLifecycleRequestError extends Error {}
class InvalidLifecycleStateError extends Error {}
class LifecycleAuditError extends Error {}

interface RouteContext {
  params: Promise<{ run_id: string }>;
}

export interface PluginJobLifecycleRouteDependencies {
  getRunner(): Promise<PluginJobRunnerPort>;
  writeAudit(input: AuditEventInput): Promise<unknown>;
}

const defaultDependencies: PluginJobLifecycleRouteDependencies = {
  async getRunner() {
    return new PluginJobRunner(await getMongoPluginJobStore());
  },
  writeAudit: recordAudit,
};

function parseRunId(value: unknown): string {
  const runId = typeof value === "string" ? value.trim() : "";
  if (
    !runId ||
    runId.length > MAX_RUN_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId)
  ) {
    throw new InvalidLifecycleRequestError("run_id 格式无效");
  }
  return runId;
}

function parseReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidLifecycleRequestError("reason 必须是字符串");
  }
  const reason = value.trim();
  if (!reason || reason.length > MAX_REASON_LENGTH || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new InvalidLifecycleRequestError(
      `reason 必须是 1 到 ${MAX_REASON_LENGTH} 个可打印字符`
    );
  }
  return reason;
}

function parseAction(value: unknown): LifecycleAction {
  if (!LIFECYCLE_ACTIONS.includes(value as LifecycleAction)) {
    throw new InvalidLifecycleRequestError("action 仅支持 cancel 或 retry");
  }
  return value as LifecycleAction;
}

async function parseBody(request: NextRequest): Promise<{
  action: LifecycleAction;
  reason?: string;
}> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new InvalidLifecycleRequestError("任务操作必须使用 application/json");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_BODY_BYTES) {
      throw new InvalidLifecycleRequestError("任务操作请求体过大");
    }
  }

  if (!request.body) {
    throw new InvalidLifecycleRequestError("请求体必须是 JSON 对象");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new InvalidLifecycleRequestError("任务操作请求体过大");
    }
    chunks.push(value);
  }

  let parsed: unknown;
  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidLifecycleRequestError("请求体必须是合法 JSON 对象");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidLifecycleRequestError("请求体必须是合法 JSON 对象");
  }
  const body = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(body).filter(
    (key) => key !== "action" && key !== "reason"
  );
  if (unknownKeys.length > 0) {
    throw new InvalidLifecycleRequestError("请求体包含不支持的字段");
  }
  const reason = parseReason(body.reason);
  return {
    action: parseAction(body.action),
    ...(reason ? { reason } : {}),
  };
}

function assertGenericHostRun(run: PluginJobRun): void {
  if (
    run.control_mode !== "host" ||
    (run.host_claimable !== undefined && run.host_claimable !== true) ||
    run.job_id === LEGACY_EXTERNAL_REPORT_JOB_ID
  ) {
    throw new InvalidLifecycleStateError("只有可执行的宿主插件任务支持此操作");
  }
  // Pan migration runs have a separate fenced compatibility control path. Do
  // not mutate them here while the legacy scheduler remains in the system.
  if (run.metadata.source === "pan-scheduler") {
    throw new InvalidLifecycleStateError("Pan 迁移任务必须通过迁移控制入口操作");
  }
}

function assertActionState(run: PluginJobRun, action: LifecycleAction): void {
  if (action === "cancel") {
    if (
      !["queued", "running", "retry_waiting", "cancelled"].includes(run.status)
    ) {
      throw new InvalidLifecycleStateError("只有排队中或运行中的任务可以取消");
    }
    return;
  }
  if (run.status !== "failed" && run.status !== "partial") {
    throw new InvalidLifecycleStateError("只有失败或部分完成的任务可以重试");
  }
  if (run.cancel_requested) {
    throw new InvalidLifecycleStateError("已请求取消的任务不能重试");
  }
}

function auditSnapshot(run: PluginJobRun) {
  return {
    status: run.status,
    attempt: run.attempt,
    cancel_requested: run.cancel_requested,
    progress: { ...run.progress },
    revision: run.revision,
    ...(run.next_retry_at ? { next_retry_at: run.next_retry_at } : {}),
    ...(run.finished_at ? { finished_at: run.finished_at } : {}),
  };
}

function auditIdempotencyKey(action: LifecycleAction, runId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(`${action}:${runId}:${requestId}`)
    .digest("hex");
  return `plugin-job-${action}-${digest}`;
}

function lifecycleResponse(run: PluginJobRun) {
  const safeError = run.error
    ? redactPluginJobEventError({
        ...(run.error.code ? { code: run.error.code } : {}),
        message: run.error.message,
      })
    : undefined;
  return {
    run_id: run.run_id,
    job_id: run.job_id,
    plugin_id: run.plugin_id,
    plugin_version: run.plugin_version,
    profile_id: run.profile_id,
    status: run.status,
    attempt: run.attempt,
    cancel_requested: run.cancel_requested,
    progress: { ...run.progress },
    ...(run.next_retry_at ? { next_retry_at: run.next_retry_at } : {}),
    ...(safeError ? { error: safeError } : {}),
    revision: run.revision,
    updated_at: run.updated_at,
    ...(run.finished_at ? { finished_at: run.finished_at } : {}),
  };
}

function pluginJobErrorStatus(error: PluginJobError): number {
  if (error.code === PLUGIN_JOB_ERROR_CODES.NOT_FOUND) return 404;
  return 409;
}

export function createPluginJobLifecycleRouteHandlers(
  dependencies: PluginJobLifecycleRouteDependencies = defaultDependencies
) {
  return {
    async POST(request: NextRequest, { params }: RouteContext) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;

      let runId: string;
      let body: { action: LifecycleAction; reason?: string };
      try {
        runId = parseRunId((await params).run_id);
        body = await parseBody(request);
      } catch (error) {
        const message =
          error instanceof InvalidLifecycleRequestError
            ? error.message
            : "任务操作请求无效";
        return NextResponse.json(
          { code: 400, message, data: null },
          { status: 400 }
        );
      }

      try {
        const runner = await dependencies.getRunner();
        const current = await runner.get(runId);
        if (!current) {
          return NextResponse.json(
            { code: 404, message: "任务不存在", data: null },
            { status: 404 }
          );
        }
        assertGenericHostRun(current);
        assertActionState(current, body.action);

        const updated =
          body.action === "cancel"
            ? await runner.requestCancel(runId)
            : await runner.retry(runId);
        if (!updated) {
          return NextResponse.json(
            { code: 404, message: "任务不存在", data: null },
            { status: 404 }
          );
        }

        // A concurrent worker may finish or cancel between the preflight read
        // and mutation. Never report a successful lifecycle action for an
        // incompatible post-CAS state.
        if (
          body.action === "cancel" &&
          updated.status !== "cancelled" &&
          !(updated.status === "running" && updated.cancel_requested)
        ) {
          throw new InvalidLifecycleStateError("任务状态已改变，请刷新后重试");
        }
        if (
          body.action === "retry" &&
          updated.status !== "queued" &&
          updated.status !== "retry_waiting"
        ) {
          throw new InvalidLifecycleStateError("任务状态已改变，请刷新后重试");
        }

        const requestId = requestAuditId(request);
        try {
          await dependencies.writeAudit({
            idempotencyKey: auditIdempotencyKey(body.action, runId, requestId),
            actor: adminAuditActor(),
            action: `plugin.job.${body.action}`,
            target: { type: "plugin-job", id: runId },
            pluginId: current.plugin_id,
            pluginVersion: current.plugin_version,
            profile: current.profile_id,
            runId,
            requestId,
            reason:
              redactPluginJobEventText(
                body.reason ||
                  `管理员${body.action === "cancel" ? "取消" : "重试"}插件任务`
              ),
            before: auditSnapshot(current),
            after: auditSnapshot(updated),
            metadata: {
              operation: body.action,
              ...(current.job_id ? { job_id: current.job_id } : {}),
            },
          });
        } catch (error) {
          console.error(
            "记录插件任务生命周期审计失败:",
            error instanceof Error ? error.name : "unknown"
          );
          throw new LifecycleAuditError();
        }

        return NextResponse.json({
          code: 200,
          message: body.action === "cancel" ? "任务取消请求已提交" : "任务重试请求已提交",
          data: {
            source: "plugin_job",
            writable: true,
            operation: body.action,
            job: lifecycleResponse(updated),
          },
        });
      } catch (error) {
        if (error instanceof InvalidLifecycleStateError) {
          return NextResponse.json(
            { code: 409, message: error.message, data: null },
            { status: 409 }
          );
        }
        if (error instanceof PluginJobError) {
          return NextResponse.json(
            {
              code: pluginJobErrorStatus(error),
              message:
                error.code === PLUGIN_JOB_ERROR_CODES.NOT_FOUND
                  ? "任务不存在"
                  : "任务状态冲突，操作未提交",
              data: null,
            },
            { status: pluginJobErrorStatus(error) }
          );
        }
        if (error instanceof LifecycleAuditError) {
          return NextResponse.json(
            { code: 500, message: "任务已变更，但审计记录失败", data: null },
            { status: 500 }
          );
        }
        console.error(
          "更新插件任务生命周期失败:",
          error instanceof Error ? error.name : "unknown"
        );
        return NextResponse.json(
          { code: 500, message: "更新插件任务失败", data: null },
          { status: 500 }
        );
      }
    },
  };
}

const handlers = createPluginJobLifecycleRouteHandlers();
export const POST = handlers.POST;
