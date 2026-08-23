import { NextResponse } from "next/server";
import { isPluginError, type PluginErrorCode } from "@/lib/plugins/errors";

/** Convert a plugin boundary failure into a safe, actionable API response. */
export function pluginFailureResponse(
  error: unknown,
  profileId: string,
  fallbackMessage: string,
): NextResponse {
  const pluginCode: PluginErrorCode = isPluginError(error)
    ? error.code
    : "UPSTREAM_ERROR";
  const status =
    pluginCode === "CAPABILITY_UNAVAILABLE" || pluginCode === "CONFIGURATION_ERROR"
      ? 503
      : pluginCode === "EXECUTION_CANCELLED"
        ? 499
        : 502;
  const message = pluginCode === "CAPABILITY_UNAVAILABLE"
    ? `当前语言的内容源插件尚未安装或启用（${profileId}），请先在后台插件中心完成安装并启用`
    : pluginCode === "CONFIGURATION_ERROR"
      ? `当前语言的内容源插件配置不完整（${profileId}），请在后台检查插件配置和 API 密钥`
      : error instanceof Error ? error.message : fallbackMessage;
  return NextResponse.json(
    { code: status, error_code: pluginCode, profile_id: profileId, message, data: null },
    { status },
  );
}
