import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import {
  listAuditEvents,
  type AuditEventDoc,
  type AuditEventQuery,
} from "@/lib/compliance-db";
import {
  boundedLimit,
  complianceErrorResponse,
  optionalQueryValue,
} from "@/lib/compliance-route";

export const dynamic = "force-dynamic";

export interface AuditRouteDependencies {
  listEvents(query?: AuditEventQuery): Promise<AuditEventDoc[]>;
}

const defaultDependencies: AuditRouteDependencies = {
  listEvents: listAuditEvents,
};

function queryFromRequest(request: NextRequest): AuditEventQuery {
  const params = request.nextUrl.searchParams;
  return {
    ...(optionalQueryValue(params.get("action"), 128)
      ? { action: optionalQueryValue(params.get("action"), 128) }
      : {}),
    ...(optionalQueryValue(params.get("plugin_id"))
      ? { pluginId: optionalQueryValue(params.get("plugin_id")) }
      : {}),
    ...(optionalQueryValue(params.get("content_id"))
      ? { contentId: optionalQueryValue(params.get("content_id")) }
      : {}),
    ...(optionalQueryValue(params.get("provider_id"))
      ? { providerId: optionalQueryValue(params.get("provider_id")) }
      : {}),
    ...(optionalQueryValue(params.get("run_id"))
      ? { runId: optionalQueryValue(params.get("run_id")) }
      : {}),
    ...(optionalQueryValue(params.get("actor_id"))
      ? { actorId: optionalQueryValue(params.get("actor_id")) }
      : {}),
    ...(optionalQueryValue(params.get("before"), 100)
      ? { before: optionalQueryValue(params.get("before"), 100) }
      : {}),
    limit: boundedLimit(params.get("limit")),
  };
}

export function createAuditRouteHandlers(
  dependencies: AuditRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;
      try {
        const events = await dependencies.listEvents(queryFromRequest(request));
        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: { events },
        });
      } catch (error) {
        const failure = complianceErrorResponse(error);
        if (failure.status === 500) console.error("获取审计事件失败:", error);
        return NextResponse.json(
          { code: failure.status, message: failure.message, data: null },
          { status: failure.status }
        );
      }
    },
  };
}

const handlers = createAuditRouteHandlers();
export const GET = handlers.GET;
