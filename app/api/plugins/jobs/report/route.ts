import { NextRequest, NextResponse } from "next/server";

import {
  ingestPluginJobReport,
  parseJobReportEvent,
  PluginJobReportValidationError,
  requirePluginJobReportToken,
  type JobReportEvent,
  type JobReportIngestDependencies,
} from "@/lib/plugins/job-report";
import { PluginJobError } from "@/lib/plugins/job-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

class PayloadTooLargeError extends Error {}
class InvalidEncodingError extends Error {}
class InvalidJsonError extends Error {}
class InvalidEventError extends Error {}

async function readBodyWithLimit(request: NextRequest): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    );
  } catch {
    throw new InvalidEncodingError();
  }
}

async function parseRequestEvent(request: NextRequest): Promise<JobReportEvent> {
  const raw = await readBodyWithLimit(request);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
  try {
    return parseJobReportEvent(value);
  } catch (error) {
    if (error instanceof RangeError) throw new InvalidEventError(error.message);
    throw error;
  }
}

export function createPluginJobReportRouteHandlers(
  dependencies?: JobReportIngestDependencies
) {
  return {
    async POST(request: NextRequest) {
      if (!requirePluginJobReportToken(request)) {
        return NextResponse.json({ code: 401, message: "未授权", data: null }, { status: 401 });
      }
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return NextResponse.json(
          { code: 415, message: "任务事件必须使用 application/json", data: null },
          { status: 415 }
        );
      }
      const contentLength = request.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
        return NextResponse.json({ code: 413, message: "任务事件过大", data: null }, { status: 413 });
      }
      let event: JobReportEvent;
      try {
        event = await parseRequestEvent(request);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          return NextResponse.json(
            { code: 413, message: "任务事件过大", data: null },
            { status: 413 }
          );
        }
        if (error instanceof InvalidJsonError) {
          return NextResponse.json(
            { code: 400, message: "任务事件 JSON 无效", data: null },
            { status: 400 }
          );
        }
        if (error instanceof InvalidEncodingError) {
          return NextResponse.json(
            { code: 400, message: "任务事件编码无效", data: null },
            { status: 400 }
          );
        }
        if (error instanceof InvalidEventError) {
          return NextResponse.json(
            { code: 400, message: error.message || "任务事件无效", data: null },
            { status: 400 }
          );
        }
        console.error("读取插件任务事件失败:", error instanceof Error ? error.name : "unknown");
        return NextResponse.json(
          { code: 500, message: "接收插件任务事件失败", data: null },
          { status: 500 }
        );
      }

      try {
        const run = await ingestPluginJobReport(event, dependencies);
        return NextResponse.json({
          code: 200,
          message: "任务事件已接收",
          data: { run_id: run.run_id, status: run.status, revision: run.revision },
        });
      } catch (error) {
        if (error instanceof PluginJobReportValidationError) {
          return NextResponse.json(
            { code: 400, message: "任务事件来源无效", data: null },
            { status: 400 }
          );
        }
        if (error instanceof PluginJobError) {
          return NextResponse.json(
            { code: 409, message: "任务事件冲突或无法应用", data: null },
            { status: 409 }
          );
        }
        console.error("接收插件任务事件失败:", error instanceof Error ? error.name : "unknown");
        return NextResponse.json(
          { code: 500, message: "接收插件任务事件失败", data: null },
          { status: 500 }
        );
      }
    },
  };
}

const handlers = createPluginJobReportRouteHandlers();
export const POST = handlers.POST;
