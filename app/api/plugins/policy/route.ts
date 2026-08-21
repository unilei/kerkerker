import { NextRequest, NextResponse } from "next/server";

import { requireAdminRequest } from "@/lib/admin-route";
import {
  listPluginPolicies,
  pluginPolicyApprovalIssues,
  recordAudit,
  upsertPluginPolicy,
  type AuditEventInput,
  type PluginPolicyDoc,
  type PluginPolicyInput,
  type PluginPolicyQuery,
} from "@/lib/compliance-db";
import {
  adminAuditActor,
  boundedLimit,
  complianceErrorResponse,
  optionalQueryValue,
  requestAuditId,
} from "@/lib/compliance-route";
import { pluginRegistry } from "@/lib/plugins";
import type { PluginDescriptor } from "@/lib/plugins/registry";

export const dynamic = "force-dynamic";

const POLICY_ACTIONS = [
  "approve",
  "enable",
  "disable",
  "suspend",
  "revoke",
  "reject",
  "review",
  "update",
] as const;
type PolicyAction = (typeof POLICY_ACTIONS)[number];

export interface PolicyRouteDependencies {
  listPolicies(query?: PluginPolicyQuery): Promise<PluginPolicyDoc[]>;
  upsertPolicy(input: PluginPolicyInput): Promise<PluginPolicyDoc>;
  writeAudit(input: AuditEventInput): Promise<unknown>;
  listPlugins(): readonly PluginDescriptor[];
}

const defaultDependencies: PolicyRouteDependencies = {
  listPolicies: listPluginPolicies,
  upsertPolicy: upsertPluginPolicy,
  writeAudit: recordAudit,
  listPlugins: () => pluginRegistry.list(),
};

interface PolicyMutationBody {
  action?: unknown;
  plugin_id?: unknown;
  plugin_version?: unknown;
  reason?: unknown;
  enforcement_mode?: unknown;
  owner?: unknown;
  authorization_ref?: unknown;
  license?: unknown;
  legal_basis?: unknown;
  terms_url?: unknown;
  data_purpose?: unknown;
  content_scope?: unknown;
  regions?: unknown;
  data_classification?: unknown;
  retention_days?: unknown;
  correction_contact?: unknown;
  takedown_contact?: unknown;
}

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

function policyAction(value: unknown): PolicyAction {
  if (typeof value !== "string" || !POLICY_ACTIONS.includes(value as PolicyAction)) {
    throw new RangeError("action 格式无效");
  }
  return value as PolicyAction;
}

function stringOrStringArray(value: unknown, field: string): string | readonly string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return requiredString(value, field);
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new RangeError(`${field} 格式无效`);
  }
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function regions(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new RangeError("regions 格式无效");
  }
  return value.map((item, index) => requiredString(item, `regions[${index}]`, 20));
}

function retentionDays(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 3_650) {
    throw new RangeError("retention_days 必须是 1 至 3650 的整数");
  }
  return Number(value);
}

function enforcementMode(value: unknown): "audit" | "enforce" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "audit" && value !== "enforce") {
    throw new RangeError("enforcement_mode 仅支持 audit 或 enforce");
  }
  return value;
}

function descriptorComplianceDefaults(descriptor: PluginDescriptor) {
  return {
    legalBasis: descriptor.compliance.legalBasis,
    owner: descriptor.compliance.owner,
    authorizationRef: descriptor.compliance.authorizationRef,
    dataPurpose: descriptor.compliance.dataPurpose,
    retentionDays: descriptor.compliance.retentionDays,
    correctionContact: descriptor.compliance.correctionContact,
    takedownContact: descriptor.compliance.takedownContact,
    contentScope: descriptor.compliance.contentScope,
    regions: descriptor.compliance.regions,
    dataClassification: descriptor.compliance.dataClassification,
  } as const;
}

function policySnapshot(policy: PluginPolicyDoc | undefined) {
  if (!policy) return undefined;
  const snapshot = { ...policy } as Record<string, unknown>;
  delete snapshot._id;
  delete snapshot.created_at;
  delete snapshot.updated_at;
  return snapshot;
}

function buildPolicyInput(
  body: PolicyMutationBody,
  descriptor: PluginDescriptor,
  existing: PluginPolicyDoc | undefined,
  actor: ReturnType<typeof adminAuditActor>
): { action: PolicyAction; reason: string; input: PluginPolicyInput } {
  const action = policyAction(body.action);
  const reason = requiredString(body.reason, "reason");
  const defaults = descriptorComplianceDefaults(descriptor);
  const pluginVersion = optionalString(body.plugin_version, "plugin_version", 100) || descriptor.version;
  if (pluginVersion !== descriptor.version) {
    throw new RangeError("只能修改当前已注册插件版本的策略");
  }
  if ((action === "enable" || action === "disable") && !existing) {
    throw new RangeError("插件尚未完成审批");
  }
  if (action === "enable" && existing?.status !== "approved") {
    throw new RangeError("只有已批准插件可以启用");
  }
  const owner = optionalString(body.owner, "owner") || existing?.owner || defaults.owner;
  const authorizationRef =
    optionalString(body.authorization_ref, "authorization_ref") ||
    existing?.authorization_ref ||
    defaults.authorizationRef;
  const dataPurpose =
    stringOrStringArray(body.data_purpose, "data_purpose") ||
    existing?.data_purpose ||
    defaults.dataPurpose;
  const configuredRetention = retentionDays(body.retention_days);
  const retention = configuredRetention ?? existing?.retention_days ?? defaults.retentionDays;
  const correctionContact = body.correction_contact !== undefined
    ? body.correction_contact as PluginPolicyInput["correctionContact"]
    : existing?.correction_contact || defaults.correctionContact;
  const takedownContact = body.takedown_contact !== undefined
    ? body.takedown_contact as PluginPolicyInput["takedownContact"]
    : existing?.takedown_contact || defaults.takedownContact;

  const status =
    action === "approve" || action === "enable"
      ? "approved"
      : action === "suspend"
        ? "suspended"
        : action === "revoke"
          ? "revoked"
          : action === "reject"
            ? "rejected"
            : action === "review"
              ? "pending"
              : existing?.status;
  const enabled =
    action === "approve" || action === "enable"
      ? true
      : ["disable", "suspend", "revoke", "reject", "review"].includes(action)
        ? false
        : existing?.enabled;

  return {
    action,
    reason,
    input: {
      pluginId: descriptor.id,
      pluginVersion,
      ...(status ? { status } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(enforcementMode(body.enforcement_mode)
        ? { enforcementMode: enforcementMode(body.enforcement_mode) }
        : {}),
      ...(owner ? { owner } : {}),
      ...(authorizationRef ? { authorizationRef } : {}),
      ...(optionalString(body.license, "license") ? { license: optionalString(body.license, "license") } : {}),
      legalBasis:
        optionalString(body.legal_basis, "legal_basis") ||
        existing?.legal_basis ||
        defaults.legalBasis,
      ...(optionalString(body.terms_url, "terms_url") ? { termsUrl: optionalString(body.terms_url, "terms_url") } : {}),
      ...(dataPurpose ? { dataPurpose } : {}),
      contentScope:
        stringOrStringArray(body.content_scope, "content_scope") ||
        existing?.content_scope ||
        defaults.contentScope,
      regions: regions(body.regions) || existing?.regions || defaults.regions,
      dataClassification:
        optionalString(body.data_classification, "data_classification", 100) ||
        existing?.data_classification ||
        defaults.dataClassification,
      ...(retention !== undefined ? { retentionDays: retention } : {}),
      ...(correctionContact ? { correctionContact } : {}),
      ...(takedownContact ? { takedownContact } : {}),
      ...(action === "approve"
        ? { approvedBy: actor, approvedAt: new Date().toISOString() }
        : {}),
      reason,
    },
  };
}

function approvalIssues(
  input: PluginPolicyInput,
  existing: PluginPolicyDoc | undefined,
  descriptor: PluginDescriptor
): string[] {
  const defaults = descriptorComplianceDefaults(descriptor);
  const policy = {
    plugin_id: descriptor.id,
    plugin_version: input.pluginVersion || descriptor.version,
    status: "approved" as const,
    enabled: true,
    enforcement_mode: input.enforcementMode || existing?.enforcement_mode || "enforce",
    owner: input.owner || existing?.owner,
    authorization_ref: input.authorizationRef || existing?.authorization_ref,
    license: input.license || existing?.license,
    legal_basis: input.legalBasis || existing?.legal_basis || defaults.legalBasis,
    data_purpose: input.dataPurpose || existing?.data_purpose,
    content_scope: input.contentScope || existing?.content_scope || defaults.contentScope,
    terms_url: input.termsUrl || existing?.terms_url,
    regions: input.regions ? [...input.regions] : existing?.regions || [...defaults.regions],
    data_classification:
      input.dataClassification || existing?.data_classification || defaults.dataClassification,
    retention_days: input.retentionDays || existing?.retention_days,
    correction_contact: input.correctionContact || existing?.correction_contact,
    takedown_contact: input.takedownContact || existing?.takedown_contact,
    approved_by: input.approvedBy
      ? { type: input.approvedBy.type, id: input.approvedBy.id }
      : existing?.approved_by,
    approved_at: input.approvedAt || existing?.approved_at,
  } as PluginPolicyDoc;
  return pluginPolicyApprovalIssues(policy);
}

function parsePolicyQuery(request: NextRequest): PluginPolicyQuery {
  const params = request.nextUrl.searchParams;
  const status = optionalQueryValue(params.get("status"), 100);
  const enabledRaw = params.get("enabled");
  if (enabledRaw !== null && enabledRaw !== "true" && enabledRaw !== "false") {
    throw new RangeError("enabled 仅支持 true 或 false");
  }
  return {
    ...(optionalQueryValue(params.get("plugin_id"))
      ? { pluginId: optionalQueryValue(params.get("plugin_id")) }
      : {}),
    ...(status ? { status: status.split(",") as PluginPolicyQuery["status"] } : {}),
    ...(enabledRaw !== null ? { enabled: enabledRaw === "true" } : {}),
    limit: boundedLimit(params.get("limit"), 100, 500),
  };
}

export function createPolicyRouteHandlers(
  dependencies: PolicyRouteDependencies = defaultDependencies
) {
  return {
    async GET(request: NextRequest) {
      const unauthorized = requireAdminRequest(request);
      if (unauthorized) return unauthorized;
      try {
        const query = parsePolicyQuery(request);
        const [policies, plugins] = await Promise.all([
          dependencies.listPolicies(query),
          Promise.resolve(dependencies.listPlugins()),
        ]);
        const policyByIdentity = new Map(
          policies.map((policy) => [
            `${policy.plugin_id}\u0000${policy.plugin_version}`,
            policy,
          ])
        );
        const selectedPlugins = query.pluginId
          ? plugins.filter((plugin) => plugin.id === query.pluginId)
          : query.status !== undefined || query.enabled !== undefined
            ? plugins.filter((plugin) =>
                policyByIdentity.has(`${plugin.id}\u0000${plugin.version}`)
              )
            : plugins;
        return NextResponse.json({
          code: 200,
          message: "获取成功",
          data: {
            plugins: selectedPlugins.map((plugin) => ({
              ...plugin,
              policy:
                policyByIdentity.get(`${plugin.id}\u0000${plugin.version}`) ||
                null,
            })),
            policies,
          },
        });
      } catch (error) {
        const failure = complianceErrorResponse(error);
        if (failure.status === 500) console.error("获取插件策略失败:", error);
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
        const body = parsed as PolicyMutationBody;
        const pluginId = requiredString(body.plugin_id, "plugin_id", 200);
        const plugins = dependencies.listPlugins();
        const descriptor = plugins.find((plugin) => plugin.id === pluginId);
        if (!descriptor) throw new RangeError("插件未注册，不能批准或启用");

        const existingPolicies = await dependencies.listPolicies({
          pluginId,
          limit: 20,
        });
        const requestedVersion = optionalString(body.plugin_version, "plugin_version", 100) || descriptor.version;
        const existing = existingPolicies.find(
          (policy) => policy.plugin_version === requestedVersion
        );
        const actor = adminAuditActor();
        const mutation = buildPolicyInput(body, descriptor, existing, actor);
        if (mutation.action === "approve" || mutation.action === "enable") {
          const issues = approvalIssues(mutation.input, existing, descriptor);
          if (issues.length > 0) {
            throw new RangeError(`审批材料不完整：${issues.join(", ")}`);
          }
        }
        const policy = await dependencies.upsertPolicy(mutation.input);
        await dependencies.writeAudit({
          actor,
          action: `plugin.policy.${mutation.action}`,
          target: { type: "plugin", id: descriptor.id, pluginId: descriptor.id },
          pluginId: descriptor.id,
          pluginVersion: policy.plugin_version,
          requestId: requestAuditId(request),
          reason: mutation.reason,
          before: policySnapshot(existing),
          after: policySnapshot(policy),
        });
        return NextResponse.json({
          code: 200,
          message: "策略已更新",
          data: { policy },
        });
      } catch (error) {
        const failure = complianceErrorResponse(error);
        if (failure.status === 500) console.error("更新插件策略失败:", error);
        return NextResponse.json(
          { code: failure.status, message: failure.message, data: null },
          { status: failure.status }
        );
      }
    },
  };
}

const handlers = createPolicyRouteHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
