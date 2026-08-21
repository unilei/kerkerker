import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import { getMongoPluginJobStore } from "@/lib/plugins/mongo-job-store";
import {
  PLUGIN_JOB_STATUSES,
  type PluginJobRun,
  type PluginJobStatus,
} from "@/lib/plugins/job-runner";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_RUN_ID_LENGTH = 200;

export interface PluginJobsRouteDependencies {
  listJobs(options: {
    status?: PluginJobStatus;
    limit: number;
  }): Promise<PluginJobRun[]>;
  getJob(runId: string): Promise<PluginJobRun | null>;
}

const defaultDependencies: PluginJobsRouteDependencies = {
  async listJobs(options) {
    const store = await getMongoPluginJobStore();
    return store.list(options);
  },
  async getJob(runId) {
    const store = await getMongoPluginJobStore();
    return store.get(runId);
  },
};

function parseStatus(value: string | null): PluginJobStatus | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (
    !PLUGIN_JOB_STATUSES.includes(value as PluginJobStatus)
  ) {
    throw new RangeError("status 不是有效的插件任务状态");
  }
  return value as PluginJobStatus;
}

function parseLimit(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`limit 必须是 1 到 ${MAX_LIMIT} 的整数`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit 必须是 1 到 ${MAX_LIMIT} 的整数`);
  }
  return limit;
}

function parseRunId(value: string | null): string | undefined {
  const runId = value?.trim();
  if (!runId) return undefined;
  if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_RUN_ID_LENGTH - 1}}$`).test(runId)) {
    throw new RangeError("run_id 查询参数格式无效");
  }
  return runId;
}

function queryFromRequest(request: NextRequest): {
  status?: PluginJobStatus;
  limit: number;
  runId?: string;
} {
  const params = request.nextUrl.searchParams;
  return {
    status: parseStatus(params.get("status")),
    limit: parseLimit(params.get("limit")),
    runId: parseRunId(params.get("run_id")),
  };
}

/**
 * Read-only view of the durable generic plugin job collection.
 *
 * The endpoint intentionally exposes no lifecycle mutation. The legacy Pan
 * scheduler remains the write source until an explicit dual-write migration.
 */
export function createPluginJobsRouteHandlers(
  dependencies: PluginJobsRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;

      try {
        const query = queryFromRequest(request);
        const selectedJobs = query.runId
          ? await dependencies.getJob(query.runId).then((job) =>
              job && (!query.status || job.status === query.status) ? [job] : []
            )
          : await dependencies.listJobs({
              ...(query.status ? { status: query.status } : {}),
              limit: query.limit,
            });
        if (query.runId && selectedJobs.length === 0) {
          return NextResponse.json(
            { code: 404, message: "任务不存在", data: null },
            { status: 404 }
          );
        }

        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: {
            source: "plugin_jobs",
            writable: false,
            jobs: selectedJobs,
            filters: {
              ...(query.status ? { status: query.status } : {}),
              ...(query.runId ? { runId: query.runId } : {}),
              limit: query.limit,
            },
          },
        });
      } catch (error) {
        const message =
          error instanceof RangeError ? error.message : "获取插件任务记录失败";
        const status = error instanceof RangeError ? 400 : 500;
        if (status === 500) console.error("获取插件任务记录失败:", error);
        return NextResponse.json(
          { code: status, message, data: null },
          { status }
        );
      }
    },
  };
}

const handlers = createPluginJobsRouteHandlers();
export const GET = handlers.GET;
