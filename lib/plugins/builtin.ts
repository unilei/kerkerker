import { createPluginRegistry } from "@/lib/plugins/registry";
import { doubanContentPlugin } from "@/lib/plugins/adapters/douban-content";
import { kkpanCloudDrivePlugin } from "@/lib/plugins/adapters/kkpan-cloud-drive";

/**
 * v1 trusted built-ins. Keep this list explicit: the registry must never load
 * a module from a database value or an administrator-provided string.
 */
export const BUILTIN_PLUGINS = [doubanContentPlugin, kkpanCloudDrivePlugin] as const;

export const pluginRegistry = createPluginRegistry(BUILTIN_PLUGINS);
