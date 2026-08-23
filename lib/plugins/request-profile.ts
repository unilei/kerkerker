import type { NextRequest } from "next/server";
import {
  LOCALE_COOKIE_NAME,
  parseSupportedLocale,
  profileIdForLocale,
} from "@/lib/locale";
import { getActivePluginProfileId } from "@/lib/plugins/builtin-profiles";

/**
 * Resolve a public request's profile from the allow-listed locale cookie.
 *
 * The deployment environment remains the fallback for requests without a
 * locale preference. A request can never select an arbitrary profile ID.
 */
export function getRequestPluginProfileId(request: Pick<NextRequest, "cookies">): string {
  const locale = parseSupportedLocale(
    request.cookies.get(LOCALE_COOKIE_NAME)?.value
  );
  return locale ? profileIdForLocale(locale) : getActivePluginProfileId();
}
export function getRequestLocale(request: Pick<NextRequest, "cookies">): string {
  const locale = parseSupportedLocale(
    request.cookies.get(LOCALE_COOKIE_NAME)?.value
  );
  if (locale) return locale;
  return getActivePluginProfileId() === "en-default" ? "en-US" : "zh-CN";
}
