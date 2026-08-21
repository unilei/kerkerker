import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import { TMDB_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/tmdb-content";
import { pluginRegistry } from "@/lib/plugins/builtin";
import {
  createPluginProfileRegistry,
  type PluginProfile,
} from "@/lib/plugins/profiles";

export const CN_DEFAULT_PROFILE_ID = "cn-default";
export const EN_DEFAULT_PROFILE_ID = "en-default";

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

export const enDefaultPluginProfile: PluginProfile = {
  id: EN_DEFAULT_PROFILE_ID,
  locale: "en-US",
  region: "US",
  capabilities: {
    "content.catalog": [TMDB_CONTENT_PLUGIN_ID],
    "content.calendar": [TMDB_CONTENT_PLUGIN_ID],
    "content.detail": [TMDB_CONTENT_PLUGIN_ID],
    "content.search": [TMDB_CONTENT_PLUGIN_ID],
    "asset.image": [TMDB_CONTENT_PLUGIN_ID],
  },
};

/** Selection and validation remain provider-neutral as more profiles are added. */
export const BUILTIN_PLUGIN_PROFILES = [
  cnDefaultPluginProfile,
  enDefaultPluginProfile,
] as const;

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
