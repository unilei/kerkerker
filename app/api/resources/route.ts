import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import {
  listResourceCenterResources,
  parseResourceCenterQuery,
  ResourceCenterQueryError,
  type ResourceCenterItem,
  type ResourceCenterQuery,
} from "@/lib/plugins/resource-center";

export const dynamic = "force-dynamic";

export interface ResourceCenterRouteDependencies {
  list(query: ResourceCenterQuery): Promise<readonly ResourceCenterItem[]>;
}

const defaultDependencies: ResourceCenterRouteDependencies = {
  list: listResourceCenterResources,
};

/**
 * Provider-neutral resource center read endpoint.
 *
 * Public reads must name a host `content_id`; broad listings and compatibility
 * rows are administrator-only.  The response intentionally omits legacy
 * supplier fields so a new cloud-drive adapter does not require a route fork.
 */
export function createResourceCenterRouteHandlers(
  dependencies: ResourceCenterRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const params = request.nextUrl.searchParams;
      const wantsBroadListing = !params.get("content_id")?.trim();
      const requestsLegacy = params.get("include_legacy") === "true";
      const requestsDisabled =
        params.get("include_disabled") === "true" ||
        params.get("enabled") === "false";
      const explicitAll = params.get("all") === "true";
      let admin = false;
      if (wantsBroadListing || requestsLegacy || requestsDisabled || explicitAll) {
        const unauthorized = requireAdminRequest(request);
        if (unauthorized) return unauthorized;
        admin = true;
      }

      try {
        const query = parseResourceCenterQuery(params);
        const includeDisabled = params.get("include_disabled") === "true";
        const includeLegacy = params.get("include_legacy") === "true";
        const resources = await dependencies.list({
          ...query,
          ...(includeDisabled ? {} : { enabled: query.enabled ?? true }),
          ...(includeLegacy ? { includeLegacy: true } : {}),
          ...(admin ? {} : { includeLegacy: false, publicOnly: true }),
        });
        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: {
            source: "resource-center",
            writable: false,
            resources,
            filters: {
              ...(query.contentId ? { content_id: query.contentId } : {}),
              ...(query.providerId ? { provider_id: query.providerId } : {}),
              ...(query.providerResourceId
                ? { provider_resource_id: query.providerResourceId }
                : {}),
              ...(query.platformId ? { platform_id: query.platformId } : {}),
              ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
              ...(includeDisabled ? { include_disabled: true } : {}),
              ...(includeLegacy ? { include_legacy: true } : {}),
              limit: query.limit,
            },
          },
        });
      } catch (error) {
        const status = error instanceof ResourceCenterQueryError ? 400 : 500;
        if (status === 500) {
          console.error(
            "读取统一资源中心失败:",
            error instanceof Error ? error.name : "unknown"
          );
        }
        return NextResponse.json(
          {
            code: status,
            message:
              status === 400 && error instanceof Error
                ? error.message
                : "读取统一资源中心失败",
            data: null,
          },
          { status }
        );
      }
    },
  };
}

const handlers = createResourceCenterRouteHandlers();
export const GET = handlers.GET;
