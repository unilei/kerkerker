import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import {
  createTakedown,
  listTakedowns,
  recordAudit,
  resolveTakedown,
  type AuditEventInput,
  type TakedownInput,
  type TakedownQuery,
  type TakedownRecordDoc,
  type TakedownResolutionInput,
} from "@/lib/compliance-db";
import {
  adminAuditActor,
  boundedLimit,
  complianceErrorResponse,
  optionalQueryValue,
  requestAuditId,
} from "@/lib/compliance-route";

export const dynamic = "force-dynamic";

export interface TakedownRouteDependencies {
  listRecords(query?: TakedownQuery): Promise<TakedownRecordDoc[]>;
  createRecord(input: TakedownInput): Promise<TakedownRecordDoc>;
  resolveRecord(
    id: string,
    input: TakedownResolutionInput
  ): Promise<TakedownRecordDoc | null>;
  writeAudit(input: AuditEventInput): Promise<unknown>;
}

const defaultDependencies: TakedownRouteDependencies = {
  listRecords: listTakedowns,
  createRecord: createTakedown,
  resolveRecord: resolveTakedown,
  writeAudit: recordAudit,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== "string") throw new RangeError(`${field} 格式无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RangeError(`${field} 格式无效`);
  }
  return normalized;
}

function queryFromRequest(request: NextRequest): TakedownQuery {
  const params = request.nextUrl.searchParams;
  const status = optionalQueryValue(params.get("status"), 100);
  const includeExpired = params.get("include_expired");
  if (
    includeExpired !== null &&
    includeExpired !== "true" &&
    includeExpired !== "false"
  ) {
    throw new RangeError("include_expired 仅支持 true 或 false");
  }
  return {
    ...(status ? { status: status.split(",") as TakedownQuery["status"] } : {}),
    ...(optionalQueryValue(params.get("content_id"))
      ? { contentId: optionalQueryValue(params.get("content_id")) }
      : {}),
    ...(optionalQueryValue(params.get("provider_id"))
      ? { providerId: optionalQueryValue(params.get("provider_id")) }
      : {}),
    ...(optionalQueryValue(params.get("plugin_id"))
      ? { pluginId: optionalQueryValue(params.get("plugin_id")) }
      : {}),
    ...(optionalQueryValue(params.get("resource_id"))
      ? { resourceId: optionalQueryValue(params.get("resource_id")) }
      : {}),
    ...(optionalQueryValue(params.get("before"), 100)
      ? { before: optionalQueryValue(params.get("before"), 100) }
      : {}),
    ...(includeExpired !== null
      ? { includeExpired: includeExpired === "true" }
      : {}),
    limit: boundedLimit(params.get("limit")),
  };
}

function auditTarget(record: TakedownRecordDoc) {
  return {
    type: record.target.type,
    id: record.target.id || record.takedown_id,
    contentId: record.target.content_id,
    providerId: record.target.provider_id,
    pluginId: record.target.plugin_id,
    resourceId: record.target.resource_id,
  };
}

export function createTakedownRouteHandlers(
  dependencies: TakedownRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;
      try {
        const records = await dependencies.listRecords(queryFromRequest(request));
        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: { records },
        });
      } catch (error) {
        const failure = complianceErrorResponse(error);
        if (failure.status === 500) console.error("获取下架记录失败:", error);
        return NextResponse.json(
          { code: failure.status, message: failure.message, data: null },
          { status: failure.status }
        );
      }
    },

    async POST(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;
      try {
        const parsed = (await request.json()) as unknown;
        if (!isObject(parsed)) throw new RangeError("请求体必须是合法 JSON 对象");
        const action = parsed.action === undefined ? "create" : requiredString(parsed.action, "action", 20);
        const actor = adminAuditActor();
        const requestId = requestAuditId(request);

        if (action === "create") {
          if (!isObject(parsed.target)) throw new RangeError("target 格式无效");
          const record = await dependencies.createRecord({
            idempotencyKey: optionalQueryValue(request.headers.get("idempotency-key"), 300),
            target: {
              type: requiredString(parsed.target.type, "target.type", 100),
              ...(typeof parsed.target.id === "string" ? { id: parsed.target.id } : {}),
              ...(typeof parsed.target.content_id === "string" ? { contentId: parsed.target.content_id } : {}),
              ...(typeof parsed.target.provider_id === "string" ? { providerId: parsed.target.provider_id } : {}),
              ...(typeof parsed.target.plugin_id === "string" ? { pluginId: parsed.target.plugin_id } : {}),
              ...(typeof parsed.target.resource_id === "string" ? { resourceId: parsed.target.resource_id } : {}),
              ...(typeof parsed.target.external_id === "string" ? { externalId: parsed.target.external_id } : {}),
            },
            reasonCode: requiredString(parsed.reason_code, "reason_code", 100),
            reason: requiredString(parsed.reason, "reason"),
            ...(parsed.evidence !== undefined ? { evidence: parsed.evidence } : {}),
            requestedBy: actor,
            ...(typeof parsed.effective_at === "string" ? { effectiveAt: parsed.effective_at } : {}),
            ...(typeof parsed.expires_at === "string" ? { expiresAt: parsed.expires_at } : {}),
          });
          await dependencies.writeAudit({
            actor,
            action: "takedown.create",
            target: auditTarget(record),
            pluginId: record.target.plugin_id,
            providerId: record.target.provider_id,
            contentId: record.target.content_id,
            requestId,
            reason: record.reason,
            after: record,
          });
          return NextResponse.json({
            code: 200,
            message: "下架记录已创建",
            data: { record },
          });
        }

        if (!["resolve", "reject", "expire"].includes(action)) {
          throw new RangeError("action 格式无效");
        }
        const takedownId = requiredString(parsed.takedown_id, "takedown_id", 100);
        const status = action === "resolve" ? "resolved" : action === "reject" ? "rejected" : "expired";
        const record = await dependencies.resolveRecord(takedownId, {
          status,
          resolvedBy: actor,
          ...(typeof parsed.resolution_reason === "string"
            ? { resolutionReason: parsed.resolution_reason }
            : {}),
        });
        if (!record) {
          return NextResponse.json(
            { code: 404, message: "下架记录不存在", data: null },
            { status: 404 }
          );
        }
        await dependencies.writeAudit({
          actor,
          action: `takedown.${action}`,
          target: auditTarget(record),
          pluginId: record.target.plugin_id,
          providerId: record.target.provider_id,
          contentId: record.target.content_id,
          requestId,
          reason: record.resolution_reason || record.reason,
          after: record,
        });
        return NextResponse.json({
          code: 200,
          message: "下架记录已更新",
          data: { record },
        });
      } catch (error) {
        const failure = complianceErrorResponse(error);
        if (failure.status === 500) console.error("更新下架记录失败:", error);
        return NextResponse.json(
          { code: failure.status, message: failure.message, data: null },
          { status: failure.status }
        );
      }
    },
  };
}

const handlers = createTakedownRouteHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
