import { PluginError } from "@/lib/plugins/errors";
import {
  complianceModeFromEnvironment,
  ensurePluginAllowed,
  recordAudit,
  type ComplianceEnforcementMode,
} from "@/lib/compliance-db";
import type { PluginContext } from "@/lib/plugins/types";

/**
 * The compliance store is optional during local unit tests, but production
 * enforcement must never silently continue when MongoDB cannot be reached.
 */
export async function checkPluginCompliance(options: {
  pluginId: string;
  pluginVersion: string;
  capability: string;
  profile: string;
  context: PluginContext;
  registered?: boolean;
}): Promise<void> {
  const mode = complianceModeFromEnvironment();
  let decision;
  try {
    decision = await ensurePluginAllowed({
      pluginId: options.pluginId,
      pluginVersion: options.pluginVersion,
      capability: options.capability,
      profile: options.profile,
      region: options.context.region,
      mode,
      ...(options.registered !== undefined ? { registered: options.registered } : {}),
    });
  } catch (error) {
    if (mode === "enforce") {
      throw new PluginError("CONFIGURATION_ERROR", "合规策略存储不可用，已拒绝插件调用", {
        cause: error,
      });
    }
    options.context.logger.warn("plugin.compliance.store_unavailable", {
      pluginId: options.pluginId,
      capability: options.capability,
    });
    return;
  }

  const auditAction = decision.wouldDeny
    ? "plugin.policy.would-deny"
    : "plugin.invoke";
  try {
    await recordAudit({
      idempotencyKey: `${options.context.requestId}:${auditAction}:${options.pluginId}:${options.capability}`,
      actor: { type: "system", id: "plugin-runtime" },
      action: auditAction,
      target: { type: "plugin", id: options.pluginId, pluginId: options.pluginId },
      pluginId: options.pluginId,
      pluginVersion: options.pluginVersion,
      capability: options.capability,
      profile: options.profile,
      region: options.context.region,
      requestId: options.context.requestId,
      runId: options.context.runId,
      reason: decision.reason,
      metadata: { mode: decision.mode, wouldDeny: decision.wouldDeny },
    });
  } catch (error) {
    if (mode === "enforce") {
      throw new PluginError("CONFIGURATION_ERROR", "合规审计不可用，已拒绝插件调用", {
        cause: error,
      });
    }
    options.context.logger.warn("plugin.compliance.audit_unavailable", {
      pluginId: options.pluginId,
      capability: options.capability,
    });
  }

  if (!decision.allowed) {
    throw new PluginError(
      "CAPABILITY_UNAVAILABLE",
      `插件 ${options.pluginId} 未通过合规策略：${decision.reason}`,
      { path: "compliance.policy" }
    );
  }
  if (decision.wouldDeny) {
    options.context.logger.warn("plugin.compliance.would_deny", {
      pluginId: options.pluginId,
      capability: options.capability,
      reason: decision.reason,
    });
  }
}

export function complianceMode(): ComplianceEnforcementMode {
  return complianceModeFromEnvironment();
}
