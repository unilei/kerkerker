import { PluginError, isPluginError } from "@/lib/plugins/errors";
import type {
  PluginCapability,
  PluginContext,
  PluginOperation,
} from "@/lib/plugins/types";
import { pluginRegistry as defaultRegistry } from "@/lib/plugins/builtin";
import type { PluginRegistry } from "@/lib/plugins/registry";
import { pluginProfileRegistry as defaultProfileRegistry } from "@/lib/plugins/builtin-profiles";
import type { PluginProfileRegistry } from "@/lib/plugins/profiles";

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
  const pluginId = pluginIds[0];
  if (!pluginId) {
    throw new PluginError(
      "CAPABILITY_UNAVAILABLE",
      `画像 ${profile.id} 未配置能力：${options.capability}`
    );
  }
  return invokePlugin<T>({
    ...options,
    registry: profiles.getPluginRegistry(),
    pluginId,
  });
}
