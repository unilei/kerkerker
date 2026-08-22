import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import {
  redactPluginJobEventError,
  type PluginJobEventRecord,
} from "@/lib/plugins/job-events";
import { getMongoPluginJobEventStore } from "@/lib/plugins/mongo-job-event-store";
import { getMongoPluginJobStore } from "@/lib/plugins/mongo-job-store";
import type { PluginJobRun } from "@/lib/plugins/job-runner";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const MAX_RUN_ID_LENGTH = 200;

class InvalidJobEventsQueryError extends Error {}

function toAdminEvent(event: PluginJobEventRecord) {
  const safeError = redactPluginJobEventError(event.error);
  return {
    schema: event.schema,
    event_id: event.event_id,
    run_id: event.run_id,
    sequence: event.sequence,
    kind: event.kind,
    occurred_at: event.occurred_at,
    received_at: event.received_at,
    metadata: { ...event.metadata },
    status: event.status,
    progress: { ...event.progress },
    ...(safeError ? { error: safeError } : {}),
  };
}

function pendingReceiptMatchesJob(
  job: PluginJobRun,
  pending: PluginJobEventRecord
): boolean {
  return (
    job.metadata.source === "job-report" &&
    job.actor.type === "system" &&
    pending.run_id === job.run_id &&
    pending.event_id === job.metadata.last_event_id &&
    pending.event_hash === job.metadata.last_event_hash &&
    pending.sequence === job.metadata.last_sequence &&
    pending.metadata.run_id === job.run_id &&
    pending.metadata.plugin_id === job.plugin_id &&
    pending.metadata.plugin_version === job.plugin_version &&
    pending.metadata.profile_id === job.profile_id &&
    pending.metadata.config_version === job.config_version &&
    pending.metadata.actor === job.actor.id &&
    pending.metadata.attempt === job.attempt &&
    pending.status === job.status
  );
}

function mergePendingReceipt(
  events: PluginJobEventRecord[],
  job: PluginJobRun,
  afterSequence: number | undefined
): PluginJobEventRecord[] {
  const selected = new Map(events.map((event) => [event.event_id, event]));
  const pending = job.pending_event_receipt;
  if (
    pending &&
    pendingReceiptMatchesJob(job, pending) &&
    (afterSequence === undefined || pending.sequence > afterSequence) &&
    !selected.has(pending.event_id)
  ) {
    selected.set(pending.event_id, pending);
  }
  return [...selected.values()].sort((left, right) =>
    left.sequence - right.sequence
  );
}

export interface PluginJobEventsRouteDependencies {
  getJob(runId: string): Promise<PluginJobRun | null>;
  listEvents(options: {
    runId: string;
    afterSequence?: number;
    limit: number;
  }): Promise<PluginJobEventRecord[]>;
}

const defaultDependencies: PluginJobEventsRouteDependencies = {
  async getJob(runId) {
    return (await getMongoPluginJobStore()).get(runId);
  },
  async listEvents(options) {
    return (await getMongoPluginJobEventStore()).list(options);
  },
};

function parseRunId(value: string | null): string {
  const runId = value?.trim();
  if (
    !runId ||
    !new RegExp(
      `^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_RUN_ID_LENGTH - 1}}$`
    ).test(runId)
  ) {
    throw new InvalidJobEventsQueryError("run_id 查询参数格式无效");
  }
  return runId;
}

function parseLimit(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) {
    throw new InvalidJobEventsQueryError(
      `limit 必须是 1 到 ${MAX_LIMIT} 的整数`
    );
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidJobEventsQueryError(
      `limit 必须是 1 到 ${MAX_LIMIT} 的整数`
    );
  }
  return limit;
}

function parseAfterSequence(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw new InvalidJobEventsQueryError("after_sequence 必须是非负整数");
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new InvalidJobEventsQueryError("after_sequence 必须是非负整数");
  }
  return sequence;
}

export function createPluginJobEventsRouteHandlers(
  dependencies: PluginJobEventsRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;

      try {
        const runId = parseRunId(request.nextUrl.searchParams.get("run_id"));
        const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
        const afterSequence = parseAfterSequence(
          request.nextUrl.searchParams.get("after_sequence")
        );
        const job = await dependencies.getJob(runId);
        if (!job) {
          return NextResponse.json(
            { code: 404, message: "任务不存在", data: null },
            { status: 404 }
          );
        }

        const storedEvents = await dependencies.listEvents({
          runId,
          ...(afterSequence !== undefined ? { afterSequence } : {}),
          limit: limit + 1,
        });
        const selected = mergePendingReceipt(
          storedEvents,
          job,
          afterSequence
        );
        const hasMore = selected.length > limit;
        const events = selected.slice(0, limit);
        const nextAfterSequence =
          events.at(-1)?.sequence ?? afterSequence ?? null;

        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: {
            source: "plugin_job_events",
            writable: false,
            run_id: runId,
            events: events.map(toAdminEvent),
            page: {
              limit,
              after_sequence: afterSequence ?? null,
              has_more: hasMore,
              next_after_sequence: nextAfterSequence,
            },
          },
        });
      } catch (error) {
        const message =
          error instanceof InvalidJobEventsQueryError
            ? error.message
            : "获取插件任务事件失败";
        const status = error instanceof InvalidJobEventsQueryError ? 400 : 500;
        if (status === 500) {
          console.error(
            "获取插件任务事件失败:",
            error instanceof Error ? error.name : "unknown"
          );
        }
        return NextResponse.json(
          { code: status, message, data: null },
          { status }
        );
      }
    },
  };
}

const handlers = createPluginJobEventsRouteHandlers();
export const GET = handlers.GET;
