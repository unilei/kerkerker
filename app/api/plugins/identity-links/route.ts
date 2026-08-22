import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import {
  ensurePluginAllowed,
  recordAudit,
  type AuditEventDoc,
  type AuditEventInput,
  type PluginPolicyDecision,
} from "@/lib/compliance-db";
import {
  adminAuditActor,
  requestAuditId,
} from "@/lib/compliance-route";
import {
  ContentIdentityConflictError,
  findContentIdentityById,
  isValidContentId,
  linkExternalReferenceToContentIdentity,
} from "@/lib/content-identity-db";
import { pluginRegistry } from "@/lib/plugins";
import type {
  ExternalReference,
  HostContentReference,
} from "@/lib/plugins/types";
import type { PluginDescriptor } from "@/lib/plugins/registry";

export const dynamic = "force-dynamic";

class IdentityLinkPolicyError extends Error {
  readonly decision: PluginPolicyDecision;

  constructor(decision: PluginPolicyDecision) {
    super(`内容来源未通过合规策略：${decision.reason}`);
    this.name = "IdentityLinkPolicyError";
    this.decision = decision;
  }
}

export interface IdentityLinkRouteDependencies {
  findIdentity(contentId: string): Promise<HostContentReference | null>;
  linkReference(
    contentId: string,
    reference: ExternalReference
  ): Promise<HostContentReference>;
  listPlugins(): readonly PluginDescriptor[];
  ensureProviderAllowed(options: {
    pluginId: string;
    pluginVersion: string;
    capability: string;
    profile: string;
    region: string;
    contentId: string;
    mode: "enforce";
  }): Promise<PluginPolicyDecision>;
  writeAudit(input: AuditEventInput): Promise<AuditEventDoc | unknown>;
}

const defaultDependencies: IdentityLinkRouteDependencies = {
  findIdentity: findContentIdentityById,
  linkReference: linkExternalReferenceToContentIdentity,
  listPlugins: () => pluginRegistry.list(),
  ensureProviderAllowed: ensurePluginAllowed,
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

function optionalString(value: unknown, field: string, max = 2_000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, field, max);
}

function pluginDescriptor(
  list: readonly PluginDescriptor[],
  providerId: string
): PluginDescriptor {
  const descriptor = list.find((item) => item.id === providerId);
  if (!descriptor) throw new RangeError("provider_id 必须是已注册的内容插件");
  if (!descriptor.capabilities.some((capability) => capability.id.startsWith("content."))) {
    throw new RangeError("provider_id 不是内容来源插件");
  }
  return descriptor;
}

function identityKeys(identity: HostContentReference): Set<string> {
  return new Set(
    identity.externalRefs.map((ref) => `${ref.providerId}\u0000${ref.externalId}`)
  );
}

function parseBody(body: unknown): {
  contentId: string;
  providerId: string;
  externalId: string;
  canonicalUrl?: string;
  reason: string;
  evidenceRef: string;
} {
  if (!isObject(body)) throw new RangeError("请求体格式无效");
  const canonicalUrl = optionalString(body.canonical_url, "canonical_url");
  return {
    contentId: requiredString(body.content_id, "content_id", 100),
    providerId: requiredString(body.provider_id, "provider_id", 100),
    externalId: requiredString(body.external_id, "external_id", 500),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    reason: requiredString(body.reason, "reason"),
    evidenceRef: requiredString(body.evidence_ref, "evidence_ref", 2_000),
  };
}

function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof IdentityLinkPolicyError) {
    return { status: 403, message: error.message };
  }
  if (error instanceof ContentIdentityConflictError) {
    return { status: 409, message: error.message };
  }
  if (error instanceof RangeError) {
    return { status: 400, message: error.message };
  }
  return { status: 500, message: "内容身份映射失败" };
}

/**
 * Admin-only exact cross-source mapping. This endpoint never resolves by
 * title and never creates a content identity; an operator must supply both a
 * reason and an evidence reference for the immutable audit trail.
 */
export function createIdentityLinkRouteHandlers(
  dependencies: IdentityLinkRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;
      try {
        const contentId = requiredString(
          request.nextUrl.searchParams.get("content_id"),
          "content_id",
          100
        );
        const identity = await dependencies.findIdentity(contentId);
        if (!identity) {
          return NextResponse.json(
            { code: 404, message: "内容身份不存在", data: null },
            { status: 404 }
          );
        }
        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: { identity },
        });
      } catch (error) {
        const failure = errorResponse(error);
        if (failure.status === 500) console.error("读取内容身份映射失败:", error);
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
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          throw new RangeError("请求体必须是有效 JSON");
        }
        const input = parseBody(body);
        const descriptor = pluginDescriptor(dependencies.listPlugins(), input.providerId);
        if (!isValidContentId(input.contentId)) {
          throw new RangeError("content_id 格式无效");
        }
        const before = await dependencies.findIdentity(input.contentId);
        if (!before) {
          return NextResponse.json(
            { code: 404, message: "内容身份不存在，不能创建跨来源映射", data: null },
            { status: 404 }
          );
        }

        const decision = await dependencies.ensureProviderAllowed({
          pluginId: descriptor.id,
          pluginVersion: descriptor.version,
          capability: "content.detail",
          profile: process.env.KERKERKER_PLUGIN_PROFILE?.trim() || "en-default",
          region: process.env.KERKERKER_PLUGIN_REGION?.trim() || "GLOBAL",
          contentId: input.contentId,
          mode: "enforce",
        });
        if (!decision.allowed) throw new IdentityLinkPolicyError(decision);

        const identity = await dependencies.linkReference(input.contentId, {
          providerId: input.providerId,
          externalId: input.externalId,
          ...(input.canonicalUrl ? { canonicalUrl: input.canonicalUrl } : {}),
        });
        const added = !identityKeys(before).has(`${input.providerId}\u0000${input.externalId}`);
        const requestId = requestAuditId(request);
        const audit = await dependencies.writeAudit({
          idempotencyKey: `identity-link:${requestId}`,
          actor: adminAuditActor(),
          action: "content.identity.link",
          target: {
            type: "content-identity",
            id: input.contentId,
            contentId: input.contentId,
            providerId: input.providerId,
            pluginId: input.providerId,
          },
          pluginId: input.providerId,
          pluginVersion: descriptor.version,
          capability: "content.detail",
          profile: process.env.KERKERKER_PLUGIN_PROFILE?.trim() || "en-default",
          region: process.env.KERKERKER_PLUGIN_REGION?.trim() || "GLOBAL",
          contentId: input.contentId,
          providerId: input.providerId,
          requestId,
          reason: input.reason,
          before,
          after: identity,
          metadata: {
            mapping_mode: "manual-exact",
            external_id: input.externalId,
            ...(input.canonicalUrl ? { canonical_url: input.canonicalUrl } : {}),
            evidence_ref: input.evidenceRef,
            added,
          },
        });
        return NextResponse.json({
          code: 200,
          message: added ? "内容身份映射已添加" : "内容身份映射已存在",
          data: { identity, added, audit },
        });
      } catch (error) {
        const failure = errorResponse(error);
        if (failure.status === 500) console.error("写入内容身份映射失败:", error);
        return NextResponse.json(
          { code: failure.status, message: failure.message, data: null },
          { status: failure.status }
        );
      }
    },
  };
}

const handlers = createIdentityLinkRouteHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
