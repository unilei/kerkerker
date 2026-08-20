import { PluginError } from "@/lib/plugins/errors";
import type { PluginRegistry } from "@/lib/plugins/registry";
import {
  PLUGIN_CAPABILITIES,
  type Plugin,
  type PluginCapability,
} from "@/lib/plugins/types";

const PROFILE_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const PLUGIN_ID_PATTERN = PROFILE_ID_PATTERN;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const REGION_PATTERN = /^[A-Z]{2}$/;
const PROFILE_FIELDS = new Set(["id", "locale", "region", "capabilities"]);
const CAPABILITY_SET = new Set<string>(PLUGIN_CAPABILITIES);

export type PluginProfileBindings = Readonly<
  Partial<Record<PluginCapability, readonly string[]>>
>;

/**
 * A deployment profile selects providers by capability. Array order is the
 * host's priority order; it does not grant plugins permission to call peers.
 */
export interface PluginProfile {
  readonly id: string;
  readonly locale: string;
  readonly region: string;
  readonly capabilities: PluginProfileBindings;
}

function configurationError(message: string, path: string): never {
  throw new PluginError("CONFIGURATION_ERROR", message, { path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportsLocale(plugin: Plugin, locale: string): boolean {
  const normalizedLocale = locale.toLowerCase();
  const language = normalizedLocale.split("-", 1)[0];
  return plugin.manifest.locales.some(
    (supportedLocale) => {
      const normalizedSupported = supportedLocale.toLowerCase();
      return (
        normalizedSupported === normalizedLocale ||
        (!normalizedSupported.includes("-") && normalizedSupported === language)
      );
    }
  );
}

function supportsRegion(plugin: Plugin, region: string): boolean {
  return plugin.manifest.compliance.regions.some(
    (supportedRegion) => supportedRegion === "GLOBAL" || supportedRegion === region
  );
}

function normalizeProfile(
  value: unknown,
  pluginRegistry: PluginRegistry,
  index: number
): PluginProfile {
  const rootPath = `profiles[${index}]`;
  if (!isRecord(value)) {
    configurationError("插件画像必须是对象", rootPath);
  }

  for (const field of Object.keys(value)) {
    if (!PROFILE_FIELDS.has(field)) {
      configurationError(`插件画像包含未知字段：${field}`, `${rootPath}.${field}`);
    }
  }

  const { id, locale, region, capabilities } = value;
  if (typeof id !== "string" || !PROFILE_ID_PATTERN.test(id)) {
    configurationError("画像 ID 格式无效", `${rootPath}.id`);
  }
  if (typeof locale !== "string" || !LOCALE_PATTERN.test(locale)) {
    configurationError("画像 locale 必须是有效的 BCP 47 标签", `${rootPath}.locale`);
  }
  if (typeof region !== "string" || !REGION_PATTERN.test(region)) {
    configurationError("画像 region 必须是大写 ISO 3166-1 alpha-2 代码", `${rootPath}.region`);
  }
  if (!isRecord(capabilities) || Object.keys(capabilities).length === 0) {
    configurationError("画像至少需要绑定一项能力", `${rootPath}.capabilities`);
  }

  const normalizedBindings: Partial<
    Record<PluginCapability, readonly string[]>
  > = {};

  for (const [capabilityId, binding] of Object.entries(capabilities)) {
    const capabilityPath = `${rootPath}.capabilities.${capabilityId}`;
    if (!CAPABILITY_SET.has(capabilityId)) {
      throw new PluginError("UNKNOWN_CAPABILITY", `画像 ${id} 包含未知能力：${capabilityId}`, {
        path: capabilityPath,
      });
    }
    if (!Array.isArray(binding) || binding.length === 0) {
      configurationError(`能力 ${capabilityId} 至少需要绑定一个插件`, capabilityPath);
    }

    const capability = capabilityId as PluginCapability;
    const seenPluginIds = new Set<string>();
    const pluginIds: string[] = [];

    binding.forEach((pluginId, pluginIndex) => {
      const pluginPath = `${capabilityPath}[${pluginIndex}]`;
      if (typeof pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pluginId)) {
        configurationError("画像中的插件 ID 格式无效", pluginPath);
      }
      if (seenPluginIds.has(pluginId)) {
        configurationError(
          `画像 ${id} 的能力 ${capability} 重复绑定插件：${pluginId}`,
          pluginPath
        );
      }

      const plugin = pluginRegistry.get(pluginId);
      if (!plugin) {
        configurationError(`画像 ${id} 引用了未注册插件：${pluginId}`, pluginPath);
      }
      if (!plugin.manifest.capabilities.some((declared) => declared.id === capability)) {
        throw new PluginError(
          "UNSUPPORTED_CAPABILITY",
          `插件 ${pluginId} 未声明画像 ${id} 绑定的能力 ${capability}`,
          { path: pluginPath }
        );
      }
      if (!supportsLocale(plugin, locale)) {
        configurationError(
          `插件 ${pluginId} 不支持画像 ${id} 的 locale：${locale}`,
          pluginPath
        );
      }
      if (!supportsRegion(plugin, region)) {
        configurationError(
          `插件 ${pluginId} 不支持画像 ${id} 的 region：${region}`,
          pluginPath
        );
      }

      seenPluginIds.add(pluginId);
      pluginIds.push(pluginId);
    });

    normalizedBindings[capability] = Object.freeze(pluginIds);
  }

  return Object.freeze({
    id,
    locale,
    region,
    capabilities: Object.freeze(normalizedBindings),
  });
}

/** Immutable, startup-validated profile registry. */
export class PluginProfileRegistry {
  private readonly profiles = new Map<string, PluginProfile>();
  private readonly pluginRegistry: PluginRegistry;
  private sealed = false;

  constructor(pluginRegistry: PluginRegistry, profiles: readonly PluginProfile[]) {
    this.pluginRegistry = pluginRegistry;
    profiles.forEach((profile, index) => this.register(profile, index));
    this.seal();
  }

  private register(profile: PluginProfile, index: number): void {
    if (this.sealed) {
      configurationError("插件画像注册中心已经封存", `profiles[${index}]`);
    }

    const normalized = normalizeProfile(profile, this.pluginRegistry, index);
    if (this.profiles.has(normalized.id)) {
      configurationError(`重复的插件画像 ID：${normalized.id}`, `profiles[${index}].id`);
    }
    this.profiles.set(normalized.id, normalized);
  }

  private seal(): void {
    this.sealed = true;
  }

  get(id: string): PluginProfile | undefined {
    return this.profiles.get(id);
  }

  require(id: string): PluginProfile {
    const profile = this.get(id);
    if (!profile) {
      configurationError(`未注册的插件画像：${id}`, "profile");
    }
    return profile;
  }

  list(): readonly PluginProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getPluginIds(
    profileId: string,
    capability: PluginCapability
  ): readonly string[] {
    if (!CAPABILITY_SET.has(capability)) {
      throw new PluginError("UNKNOWN_CAPABILITY", `未知插件能力：${capability}`, {
        path: "capability",
      });
    }

    const profile = this.require(profileId);
    const pluginIds = profile.capabilities[capability];
    if (!pluginIds?.length) {
      throw new PluginError(
        "CAPABILITY_UNAVAILABLE",
        `画像 ${profileId} 未配置能力：${capability}`,
        { path: `profiles.${profileId}.capabilities.${capability}` }
      );
    }
    return pluginIds;
  }

  getPluginRegistry(): PluginRegistry {
    return this.pluginRegistry;
  }

  /** Resolve plugins in the exact priority order declared by the profile. */
  resolve(
    profileId: string,
    capability: PluginCapability
  ): readonly Plugin[] {
    return this.getPluginIds(profileId, capability).map((pluginId) =>
      this.pluginRegistry.require(pluginId)
    );
  }
}

export function createPluginProfileRegistry(
  pluginRegistry: PluginRegistry,
  profiles: readonly PluginProfile[]
): PluginProfileRegistry {
  return new PluginProfileRegistry(pluginRegistry, profiles);
}
