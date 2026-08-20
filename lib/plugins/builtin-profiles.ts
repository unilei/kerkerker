import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import { pluginRegistry } from "@/lib/plugins/builtin";
import {
  createPluginProfileRegistry,
  type PluginProfile,
} from "@/lib/plugins/profiles";

export const CN_DEFAULT_PROFILE_ID = "cn-default";

export const cnDefaultPluginProfile: PluginProfile = {
  id: CN_DEFAULT_PROFILE_ID,
  locale: "zh-CN",
  region: "CN",
  capabilities: {
    "content.catalog": [DOUBAN_CONTENT_PLUGIN_ID],
    "content.calendar": [DOUBAN_CONTENT_PLUGIN_ID],
    "content.detail": [DOUBAN_CONTENT_PLUGIN_ID],
    "content.search": [DOUBAN_CONTENT_PLUGIN_ID],
    "resource.cloud-drive": [KKPAN_PLUGIN_ID],
    "asset.image": [DOUBAN_CONTENT_PLUGIN_ID],
    recommendation: [DOUBAN_CONTENT_PLUGIN_ID],
  },
};

/**
 * Add future profiles (for example en-default with TMDB) to this static list.
 * Selection and validation logic remains provider-neutral.
 */
export const BUILTIN_PLUGIN_PROFILES = [cnDefaultPluginProfile] as const;

export const pluginProfileRegistry = createPluginProfileRegistry(
  pluginRegistry,
  BUILTIN_PLUGIN_PROFILES
);

/** Deployment-owned selection; public callers cannot choose a regional profile. */
export function getActivePluginProfileId(): string {
  const profileId = process.env.KERKERKER_PLUGIN_PROFILE?.trim() || CN_DEFAULT_PROFILE_ID;
  pluginProfileRegistry.require(profileId);
  return profileId;
}
