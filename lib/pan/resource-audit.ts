import type { NextRequest } from "next/server";

import { recordAudit, type AuditEventInput } from "@/lib/compliance-db";
import {
  complianceModeFromEnvironment,
  ensurePluginAllowed,
  getActiveTakedown,
} from "@/lib/compliance-db";
import {
  adminAuditActor,
  requestAuditId,
} from "@/lib/compliance-route";
import type { PanResource } from "@/types/pan-resource";

type ResourceMutation = "create" | "update" | "delete";

export type ActiveTakedownLookup = (target: {
  contentId?: string;
  providerId?: string;
  pluginId?: string;
  resourceId?: string;
}) => Promise<unknown | null>;

export type ResourcePolicyLookup = (options: {
  pluginId: string;
  capability: string;
  profile: string;
  region: string;
  contentId?: string;
}) => Promise<{ allowed: boolean; wouldDeny?: boolean; reason?: string }>;

/**
 * Apply takedown policy to public resource responses. Admin listings are
 * intentionally not filtered so operators can inspect and remediate records.
 * Lookup failures are fail-open only during the explicitly transitional audit
 * mode; enforce mode fails closed so an unavailable policy store cannot expose
 * content that should be hidden.
 */
export async function filterPublicPanResources<T extends PanResource>(
  resources: readonly T[],
  lookup: ActiveTakedownLookup = getActiveTakedown,
  scope: { contentId?: string } = {},
  policyLookup: ResourcePolicyLookup = ensurePluginAllowed
): Promise<T[]> {
  if (resources.length === 0) return [];

  const checks = new Map<
    string,
    {
      kind: "content" | "provider" | "resource";
      key: string;
      target: Parameters<ActiveTakedownLookup>[0];
    }
  >();
  if (scope.contentId) {
    checks.set(`content:${scope.contentId}`, {
      kind: "content",
      key: scope.contentId,
      target: { contentId: scope.contentId },
    });
  }
  for (const resource of resources) {
    if (resource.content_id) {
      const key = `content:${resource.content_id}`;
      checks.set(key, {
        kind: "content",
        key: resource.content_id,
        target: { contentId: resource.content_id },
      });
    }
    if (resource.provider_id) {
      const key = `provider:${resource.provider_id}`;
      checks.set(key, {
        kind: "provider",
        key: resource.provider_id,
        target: { providerId: resource.provider_id, pluginId: resource.provider_id },
      });
    }
    const key = `resource:${resource.id}`;
    checks.set(key, {
      kind: "resource",
      key: resource.id,
      target: { resourceId: resource.id },
    });
  }

  const blocked = new Set<string>();
  try {
    const results = await Promise.all(
      [...checks.values()].map(async (check) => ({
        check,
        takedown: await lookup(check.target),
      }))
    );
    for (const result of results) {
      if (result.takedown) blocked.add(`${result.check.kind}:${result.check.key}`);
    }
  } catch (error) {
    if (complianceModeFromEnvironment() === "enforce") throw error;
    console.warn("公开网盘资源下架策略暂不可用，审计模式保留兼容读取", error);
    return [...resources];
  }

  const scopeContentBlocked = Boolean(
    scope.contentId && blocked.has(`content:${scope.contentId}`)
  );

  const policyBlocked = new Set<string>();
  const providerIds = [
    ...new Set(
      resources
        .map((resource) => resource.provider_id)
        .filter((providerId): providerId is string => Boolean(providerId))
    ),
  ];
  if (providerIds.length > 0) {
    try {
      const policyResults = await Promise.all(
        providerIds.map(async (providerId) => ({
          providerId,
          decision: await policyLookup({
            pluginId: providerId,
            capability: "resource.cloud-drive",
            profile: process.env.KERKERKER_PLUGIN_PROFILE?.trim() || "cn-default",
            region: process.env.KERKERKER_PLUGIN_REGION?.trim() || "CN",
            ...(scope.contentId ? { contentId: scope.contentId } : {}),
          }),
        }))
      );
      for (const result of policyResults) {
        if (!result.decision.allowed) policyBlocked.add(result.providerId);
      }
    } catch (error) {
      if (complianceModeFromEnvironment() === "enforce") throw error;
      console.warn("公开网盘资源来源策略暂不可用，审计模式保留兼容读取", error);
    }
  }

  return resources.filter((resource) => {
    if (scopeContentBlocked) return false;
    if (resource.content_id && blocked.has(`content:${resource.content_id}`)) return false;
    if (resource.provider_id && blocked.has(`provider:${resource.provider_id}`)) return false;
    if (resource.provider_id && policyBlocked.has(resource.provider_id)) return false;
    return !blocked.has(`resource:${resource.id}`);
  });
}

function auditSnapshot(resource: PanResource): PanResource {
  return {
    ...resource,
    // `code` is a share/extraction credential even though its short field
    // name cannot be safely classified by the generic redactor.
    ...(resource.code ? { code: "[REDACTED]" } : {}),
  };
}

export async function recordPanResourceMutation(
  request: Pick<NextRequest, "headers">,
  mutation: ResourceMutation,
  resource: PanResource,
  options: { before?: PanResource; reason?: string } = {},
  writeAudit: (input: AuditEventInput) => Promise<unknown> = recordAudit
): Promise<void> {
  await writeAudit({
    actor: adminAuditActor(),
    action: `resource.pan.${mutation}`,
    target: {
      type: "pan-resource",
      id: resource.id,
      resourceId: resource.id,
      contentId: resource.content_id,
      providerId: resource.provider_id,
      pluginId: resource.provider_id,
    },
    ...(resource.provider_id ? { pluginId: resource.provider_id } : {}),
    ...(resource.provider_id ? { providerId: resource.provider_id } : {}),
    ...(resource.content_id ? { contentId: resource.content_id } : {}),
    requestId: requestAuditId(request),
    reason: options.reason || `管理员${mutation === "create" ? "新增" : mutation === "update" ? "更新" : "删除"}网盘资源`,
    ...(options.before ? { before: auditSnapshot(options.before) } : {}),
    ...(mutation !== "delete" ? { after: auditSnapshot(resource) } : {}),
  });
}
