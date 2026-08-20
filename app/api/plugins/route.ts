import { NextRequest, NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/admin-route";
import { pluginProfileRegistry, pluginRegistry } from "@/lib/plugins";
import type { PluginProfile } from "@/lib/plugins/profiles";
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_CONTRACT_VERSION,
  type PluginCapability,
} from "@/lib/plugins/types";

export const dynamic = "force-dynamic";

function badRequest(message: string) {
  return NextResponse.json(
    { code: 400, message, data: null },
    { status: 400 }
  );
}

function isCapability(value: string): value is PluginCapability {
  return (PLUGIN_CAPABILITIES as readonly string[]).includes(value);
}

function publicProfile(profile: PluginProfile) {
  return {
    id: profile.id,
    locale: profile.locale,
    region: profile.region,
    capabilities: profile.capabilities,
  };
}

/**
 * Returns public, non-secret metadata for the statically registered plugins.
 * Configuration values, credentials, and runtime health details are never
 * exposed by this endpoint.
 */
export async function GET(request: NextRequest) {
  const unauthorized = requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  const capability = request.nextUrl.searchParams.get("capability");
  const profileId = request.nextUrl.searchParams.get("profile");
  const selectedCapability = capability && isCapability(capability) ? capability : undefined;
  if (capability && !selectedCapability) {
    return badRequest("无效的插件能力");
  }

  let profile: ReturnType<typeof publicProfile> | undefined;
  let profilePluginIds: readonly string[] | undefined;
  if (profileId) {
    try {
      const selectedProfile = pluginProfileRegistry.require(profileId);
      profile = publicProfile(selectedProfile);
      if (selectedCapability) {
        profilePluginIds = pluginProfileRegistry.getPluginIds(profileId, selectedCapability);
      } else {
        profilePluginIds = [
          ...new Set(Object.values(selectedProfile.capabilities).flatMap((ids) => ids || [])),
        ];
      }
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "无效的插件画像");
    }
  }

  const descriptors = pluginRegistry.list();
  const plugins = selectedCapability
    ? descriptors.filter((plugin) =>
        plugin.capabilities.some((declaration) => declaration.id === selectedCapability) &&
        (!profilePluginIds || profilePluginIds.includes(plugin.id))
      )
    : profilePluginIds
      ? descriptors.filter((plugin) => profilePluginIds?.includes(plugin.id))
      : descriptors;

  return NextResponse.json({
    code: 200,
    message: "获取成功",
    data: {
      contractVersion: PLUGIN_CONTRACT_VERSION,
      plugins,
      profiles: profile ? [profile] : pluginProfileRegistry.list().map(publicProfile),
    },
  });
}
