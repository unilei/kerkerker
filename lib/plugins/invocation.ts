import { PluginError } from "@/lib/plugins/errors";
import { createPluginContext, type CreatePluginContextOptions } from "@/lib/plugins/context";
import { pluginProfileRegistry } from "@/lib/plugins/builtin-profiles";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import type {
  PluginCapability,
  PluginContext,
  PluginManifest,
} from "@/lib/plugins/types";

interface RuntimeSettings {
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, string | undefined>>;
}

type RuntimeSettingsLoader = () => RuntimeSettings;

const RUNTIME_SETTINGS_LOADERS: Readonly<Record<string, RuntimeSettingsLoader>> =
  Object.freeze({
    [DOUBAN_CONTENT_PLUGIN_ID]: () => ({
      config: {
        baseUrl:
          process.env.NEXT_PUBLIC_DOUBAN_API_URL ||
          "https://iamyourfather.link0.me",
      },
      secrets: { serviceToken: process.env.DOUBAN_SERVICE_TOKEN },
    }),
    [KKPAN_PLUGIN_ID]: () => ({
      config: {
        baseUrl: process.env.KKPAN_API_BASE || "https://www.kkpans.com",
      },
    }),
  });

function configuredHost(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname
      : null;
  } catch {
    return null;
  }
}

function allowedHost(entry: string): string {
  return configuredHost(entry) || entry;
}

function assertRuntimeSettings(
  manifest: PluginManifest,
  settings: RuntimeSettings
): void {
  for (const field of manifest.config.fields) {
    const source = field.secret ? settings.secrets : settings.config;
    const value = source?.[field.key];
    if (field.required && (value === undefined || value === null || value === "")) {
      throw new PluginError(
        "CONFIGURATION_ERROR",
        `插件 ${manifest.id} 缺少必需配置：${field.key}`,
        { path: `config.${field.key}` }
      );
    }
    if (value === undefined || value === null || value === "") continue;
    if (field.type === "url") {
      if (typeof value !== "string") {
        throw new PluginError(
          "CONFIGURATION_ERROR",
          `插件 ${manifest.id} 的 ${field.key} 必须是 URL`,
          { path: `config.${field.key}` }
        );
      }
      const hostname = configuredHost(value);
      if (!hostname) {
        throw new PluginError(
          "CONFIGURATION_ERROR",
          `插件 ${manifest.id} 的 ${field.key} 必须是 HTTP(S) URL`,
          { path: `config.${field.key}` }
        );
      }
      const allowed = manifest.permissions.networkHosts.some(
        (entry) => allowedHost(entry) === hostname
      );
      if (!allowed) {
        throw new PluginError(
          "CONFIGURATION_ERROR",
          `插件 ${manifest.id} 的 ${field.key} 不在网络权限声明中`,
          { path: `config.${field.key}` }
        );
      }
    }
  }
}

export interface CreateProfileInvocationOptions
  extends Omit<CreatePluginContextOptions, "config" | "secrets"> {
  readonly capability: PluginCapability;
}

export interface ProfileInvocation {
  readonly pluginId: string;
  readonly context: PluginContext;
}

/**
 * Resolve the selected plugin and inject its server-only runtime settings.
 * API routes never need to know provider environment variable names.
 */
export function createProfileInvocation(
  options: CreateProfileInvocationOptions
): ProfileInvocation {
  const { capability, ...contextOptions } = options;
  const pluginId = pluginProfileRegistry.getPluginIds(
    contextOptions.profileId,
    capability
  )[0];
  const plugin = pluginProfileRegistry.getPluginRegistry().require(pluginId);
  const loadSettings = RUNTIME_SETTINGS_LOADERS[pluginId];
  if (!loadSettings) {
    throw new PluginError(
      "CONFIGURATION_ERROR",
      `插件 ${pluginId} 没有注册宿主运行配置`,
      { path: `runtimeSettings.${pluginId}` }
    );
  }
  const settings = loadSettings();
  assertRuntimeSettings(plugin.manifest, settings);
  return Object.freeze({
    pluginId,
    context: createPluginContext({
      ...contextOptions,
      config: settings.config,
      secrets: settings.secrets,
    }),
  });
}
