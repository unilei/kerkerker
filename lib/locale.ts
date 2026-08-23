/** Supported public UI/content locales. Keep this list intentionally small
 * until each locale has an installed and approved content profile. */
export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";
export const LOCALE_COOKIE_NAME = "kk_locale";

export function parseSupportedLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
    ? (value as SupportedLocale)
    : null;
}
export function profileIdForLocale(locale: SupportedLocale): "cn-default" | "en-default" {
  return locale === "en-US" ? "en-default" : "cn-default";
}
