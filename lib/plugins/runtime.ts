import { PluginError, isPluginError } from "@/lib/plugins/errors";
import { recordAudit } from "@/lib/compliance-db";
import type {
  PluginCapability,
  PluginContext,
  PluginOperation,
} from "@/lib/plugins/types";
import { pluginRegistry as defaultRegistry } from "@/lib/plugins/builtin";
import type { PluginRegistry } from "@/lib/plugins/registry";
import { pluginProfileRegistry as defaultProfileRegistry } from "@/lib/plugins/builtin-profiles";
import type { PluginProfileRegistry } from "@/lib/plugins/profiles";
import { checkPluginCompliance } from "@/lib/plugins/compliance";
import { invokeRemoteSidecar } from "@/lib/plugins/sidecar";
import {
  requireUsable,
  type PluginInstallationStore,
} from "@/lib/plugins/installation";

/** Operations are allow-listed; the host never executes a request-supplied method name. */
const OPERATIONS_BY_CAPABILITY: Readonly<Record<PluginCapability, readonly PluginOperation[]>> = {
  "content.catalog": ["catalog"],
  "content.calendar": ["calendar"],
  "content.detail": ["detail"],
  "content.search": ["search"],
  "resource.cloud-drive": ["search", "incremental", "availability"],
  "resource.playback": ["playback"],
  "interaction.danmu": ["danmu"],
  "asset.image": ["image"],
  recommendation: ["recommendation"],
};

export interface InvokePluginOptions {
  readonly registry?: PluginRegistry;
  /** Test/host override for the installation gate. Production defaults to on. */
  readonly enforceInstallation?: boolean;
  readonly installationStore?: PluginInstallationStore;
  readonly pluginId: string;
  readonly capability: PluginCapability;
  readonly operation: PluginOperation;
  readonly context: PluginContext;
  readonly request: unknown;
}

/** Invoke a statically registered operation through one host error/cancellation boundary. */
export async function invokePlugin<T>(options: InvokePluginOptions): Promise<T> {
  const registry = options.registry || defaultRegistry;
  const { capability, operation, context } = options;

  const allowedOperations = OPERATIONS_BY_CAPABILITY[capability];
  if (!allowedOperations || !allowedOperations.includes(operation)) {
    throw new PluginError(
      "UNSUPPORTED_CAPABILITY",
      `操作 ${operation} 不属于能力 ${capability}`,
      { path: "operation" }
    );
  }
  if (context.signal.aborted) {
    throw new PluginError("EXECUTION_CANCELLED", "插件调用已取消");
  }

  let plugin;
  try {
    plugin = registry.require(options.pluginId);
  } catch (error) {
    if (isPluginError(error)) throw error;
    throw new PluginError("CONFIGURATION_ERROR", "插件注册状态不可用", { cause: error });
  }

  // Custom registries are used by isolated contract tests and package
  // validation. Only the sealed host registry is executable in production;
  // it must have an explicit operator installation and enablement record.
  const enforceInstallation =
    options.enforceInstallation ??
    (registry === defaultRegistry &&
      (process.env.NODE_ENV === "production" ||
        process.env.KERKERKER_PLUGIN_INSTALLATION_ENFORCE === "true"));
  if (enforceInstallation && registry === defaultRegistry) {
    await requireUsable(options.pluginId, {
      version: plugin.manifest.version,
      ...(options.installationStore ? { store: options.installationStore } : {}),
    });
  }

  await checkPluginCompliance({
    pluginId: options.pluginId,
    pluginVersion: plugin.manifest.version,
    capability,
    profile: context.profile,
    context,
    // The caller's registry is the trust boundary for this invocation. The
    // compliance repository also checks the built-in registry by default, so
    // pass the already-validated membership explicitly for package/fixture
    // registries without weakening the static registration requirement.
    registered: Boolean(registry.get(options.pluginId)),
  });

  if (plugin.manifest.runtime.mode === "remote") {
    return invokeRemoteSidecar<T>({
      manifest: plugin.manifest,
      capability,
      operation,
      context,
      request: options.request,
    });
  }

  const implementation = plugin.capabilities[capability];
  if (!implementation) {
    throw new PluginError(
      "CAPABILITY_UNAVAILABLE",
      `插件 ${options.pluginId} 未启用能力 ${capability}`,
      { path: `capabilities.${capability}` }
    );
  }

  const method = (implementation as Record<string, unknown>)[operation];
  if (typeof method !== "function") {
    throw new PluginError(
      "UNSUPPORTED_CAPABILITY",
      `插件 ${options.pluginId} 未实现操作 ${operation}`,
      { path: `capabilities.${capability}.${operation}` }
    );
  }

  try {
    const result = await (method as (ctx: PluginContext, request: unknown) => Promise<T>).call(
      implementation,
      context,
      options.request
    );
    if (context.signal.aborted) {
      throw new PluginError("EXECUTION_CANCELLED", "插件调用已取消");
    }
    return result;
  } catch (error) {
    if (isPluginError(error)) throw error;
    if (context.signal.aborted) {
      throw new PluginError("EXECUTION_CANCELLED", "插件调用已取消", { cause: error });
    }
    throw new PluginError("EXECUTION_FAILED", "插件调用失败", { cause: error });
  }
}

export interface InvokeProfilePluginOptions
  extends Omit<InvokePluginOptions, "pluginId" | "registry"> {
  readonly profileId: string;
  readonly profileRegistry?: PluginProfileRegistry;
}

async function recordPluginFallback(
  context: PluginContext,
  capability: PluginCapability,
  fromPluginId: string,
  toPluginId: string,
  fromVersion?: string,
  toVersion?: string
): Promise<void> {
  try {
    await recordAudit({
      idempotencyKey: `${context.requestId}:plugin-fallback:${fromPluginId}:${toPluginId}:${capability}`,
      actor: { type: "system", id: "plugin-runtime" },
      action: "plugin.fallback",
      target: { type: "plugin", id: toPluginId, pluginId: toPluginId },
      pluginId: toPluginId,
      pluginVersion: toVersion,
      capability,
      profile: context.profile,
      region: context.region,
      requestId: context.requestId,
      runId: context.runId,
      reason: "前序插件返回上游错误，按画像优先级回退",
      metadata: {
        from_plugin_id: fromPluginId,
        from_plugin_version: fromVersion,
        to_plugin_id: toPluginId,
        to_plugin_version: toVersion,
      },
    });
  } catch (auditError) {
    context.logger.warn("plugin.fallback.audit_unavailable", {
      fromPluginId,
      toPluginId,
      capability,
      error: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
}

/** Resolve the first plugin selected by a deployment profile, then invoke it. */
export async function invokeProfilePlugin<T>(
  options: InvokeProfilePluginOptions
): Promise<T> {
  const profiles = options.profileRegistry || defaultProfileRegistry;
  const profile = profiles.require(options.profileId);
  if (
    options.context.profile !== profile.id ||
    options.context.locale.toLowerCase() !== profile.locale.toLowerCase() ||
    options.context.region !== profile.region
  ) {
    throw new PluginError(
      "CONFIGURATION_ERROR",
      `调用上下文与画像 ${profile.id} 不一致`,
      { path: "context.profile" }
    );
  }
  const pluginIds = profiles.getPluginIds(options.profileId, options.capability);
  if (pluginIds.length === 0) {
    throw new PluginError(
      "CAPABILITY_UNAVAILABLE",
      `画像 ${profile.id} 未配置能力：${options.capability}`
    );
  }

  let lastUpstreamError: PluginError | undefined;
  for (let index = 0; index < pluginIds.length; index += 1) {
    const pluginId = pluginIds[index];
    try {
      return await invokePlugin<T>({
        ...options,
        registry: profiles.getPluginRegistry(),
        pluginId,
      });
    } catch (error) {
      // A profile's order is an explicit failover policy. Only an upstream
      // failure is retryable; auth, compliance, configuration, cancellation,
      // and execution errors must remain visible and must not cross sources.
      if (!(error instanceof PluginError) || error.code !== "UPSTREAM_ERROR") {
        throw error;
      }
      const nextPluginId = pluginIds[index + 1];
      if (nextPluginId) {
        const registry = profiles.getPluginRegistry();
        await recordPluginFallback(
          options.context,
          options.capability,
          pluginId,
          nextPluginId,
          registry.get(pluginId)?.manifest.version,
          registry.get(nextPluginId)?.manifest.version
        );
      }
      lastUpstreamError = error;
    }
  }
  throw lastUpstreamError || new PluginError("UPSTREAM_ERROR", "画像中的插件均不可用");
}
