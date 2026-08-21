import {
  PLUGIN_CAPABILITIES,
  type Plugin,
  type PluginCapability,
  type PluginCapabilityDeclaration,
  type PluginManifest,
} from "@/lib/plugins/types";
import { PluginError } from "@/lib/plugins/errors";
import { assertPluginManifest } from "@/lib/plugins/validation";

const IMPLEMENTATION_KEYS: Record<PluginCapability, string> = {
  "content.catalog": "content.catalog",
  "content.calendar": "content.calendar",
  "content.detail": "content.detail",
  "content.search": "content.search",
  "resource.cloud-drive": "resource.cloud-drive",
  "resource.playback": "resource.playback",
  "interaction.danmu": "interaction.danmu",
  "asset.image": "asset.image",
  recommendation: "recommendation",
};

function hasMethod(value: unknown, method: string): boolean {
  return typeof (value as Record<string, unknown> | undefined)?.[method] === "function";
}

function assertCapabilityImplementation(
  plugin: Plugin,
  declaration: PluginCapabilityDeclaration
): void {
  const implementation = plugin.capabilities[IMPLEMENTATION_KEYS[declaration.id] as keyof Plugin["capabilities"]];
  if (!implementation) {
    throw new PluginError(
      "UNSUPPORTED_CAPABILITY",
      `插件 ${plugin.manifest.id} 声明了 ${declaration.id}，但没有提供实现`,
      { path: `capabilities.${declaration.id}` }
    );
  }

  if (declaration.id === "content.catalog" && !hasMethod(implementation, "catalog")) {
    throw new PluginError("UNSUPPORTED_CAPABILITY", `插件 ${plugin.manifest.id} 缺少 catalog 实现`);
  }
  if (declaration.id === "content.calendar" && !hasMethod(implementation, "calendar")) {
    throw new PluginError("UNSUPPORTED_CAPABILITY", `插件 ${plugin.manifest.id} 缺少 calendar 实现`);
  }
  if (declaration.id === "content.detail" && !hasMethod(implementation, "detail")) {
    throw new PluginError("UNSUPPORTED_CAPABILITY", `插件 ${plugin.manifest.id} 缺少 detail 实现`);
  }
  if (declaration.id === "content.search" && !hasMethod(implementation, "search")) {
    throw new PluginError("UNSUPPORTED_CAPABILITY", `插件 ${plugin.manifest.id} 缺少 search 实现`);
  }
  if (declaration.id === "resource.playback" && !hasMethod(implementation, "playback")) {
    throw new PluginError("UNSUPPORTED_CAPABILITY", `插件 ${plugin.manifest.id} 缺少 playback 实现`);
  }
  if (declaration.id === "interaction.danmu" && !hasMethod(implementation, "danmu")) {
    throw new PluginError("UNSUPPORTED_CAPABILITY", `插件 ${plugin.manifest.id} 缺少 danmu 实现`);
  }
  if (declaration.id === "asset.image" && !hasMethod(implementation, "image")) {
    throw new PluginError("UNSUPPORTED_CAPABILITY", `插件 ${plugin.manifest.id} 缺少 image 实现`);
  }
  if (declaration.id === "recommendation" && !hasMethod(implementation, "recommendation")) {
    throw new PluginError("UNSUPPORTED_CAPABILITY", `插件 ${plugin.manifest.id} 缺少 recommendation 实现`);
  }

  if (declaration.id === "resource.cloud-drive") {
    const features = declaration.features || [];
    const requiredMethods: Record<string, string> = {
      search: "search",
      incremental: "incremental",
      availability: "availability",
    };
    for (const feature of features) {
      const method = requiredMethods[feature];
      if (!hasMethod(implementation, method)) {
        throw new PluginError(
          "UNSUPPORTED_CAPABILITY",
          `插件 ${plugin.manifest.id} 缺少 cloud-drive ${feature} 实现`,
          { path: `capabilities.resource.cloud-drive.features.${feature}` }
        );
      }
    }
  }
}

export interface PluginDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly contractVersion: string;
  readonly runtime: PluginManifest["runtime"];
  readonly capabilities: readonly PluginCapabilityDeclaration[];
  readonly locales: readonly string[];
  readonly compliance: PluginManifest["compliance"];
  readonly configured: boolean;
}

function toDescriptor(plugin: Plugin): PluginDescriptor {
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    contractVersion: plugin.manifest.contractVersion,
    runtime: plugin.manifest.runtime,
    capabilities: plugin.manifest.capabilities,
    locales: plugin.manifest.locales,
    compliance: plugin.manifest.compliance,
    // v1 has static configuration only. Runtime configuration state will be
    // added to the host policy layer without exposing secret values here.
    configured: true,
  };
}

export class PluginRegistry {
  private readonly plugins = new Map<string, Plugin>();
  private sealed = false;

  constructor(plugins: readonly Plugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
    this.seal();
  }

  register(plugin: Plugin): void {
    if (this.sealed) {
      throw new PluginError("CONFIGURATION_ERROR", "插件注册中心已经封存，不能运行时替换插件");
    }
    assertPluginManifest(plugin.manifest);
    if (this.plugins.has(plugin.manifest.id)) {
      throw new PluginError("INVALID_MANIFEST", `重复的插件 ID：${plugin.manifest.id}`, {
        path: "id",
      });
    }
    if (plugin.manifest.runtime.mode !== "remote") {
      for (const declaration of plugin.manifest.capabilities) {
        assertCapabilityImplementation(plugin, declaration);
      }
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  seal(): void {
    this.sealed = true;
  }

  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  require(id: string): Plugin {
    const plugin = this.get(id);
    if (!plugin) {
      throw new PluginError("CONFIGURATION_ERROR", `未注册的插件：${id}`, { path: "id" });
    }
    return plugin;
  }

  list(): readonly PluginDescriptor[] {
    return [...this.plugins.values()]
      .map(toDescriptor)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  findByCapability(capability: PluginCapability): readonly Plugin[] {
    if (!PLUGIN_CAPABILITIES.includes(capability)) return [];
    return [...this.plugins.values()].filter((plugin) =>
      plugin.manifest.capabilities.some((declaration) => declaration.id === capability)
    );
  }
}

export function createPluginRegistry(plugins: readonly Plugin[]): PluginRegistry {
  return new PluginRegistry(plugins);
}
