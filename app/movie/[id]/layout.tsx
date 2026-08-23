import type { Metadata } from "next";
import { cookies } from "next/headers";
import { createPageMetadata } from "@/lib/seo";
import {
  getActivePluginProfileId,
  getContentDetail,
  pluginProfileRegistry,
} from "@/lib/plugins";
import {
  LOCALE_COOKIE_NAME,
  parseSupportedLocale,
  profileIdForLocale,
} from "@/lib/locale";

function preferredText(
  values: readonly { locale: string; value: string }[] | undefined,
  locale: string
): string {
  if (!values?.length) return "";
  return (
    values.find((item) => item.locale.toLowerCase() === locale.toLowerCase())?.value ||
    values[0]?.value ||
    ""
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const cookieLocale = parseSupportedLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value
  );
  const locale = cookieLocale || "zh-CN";

  try {
    const profileId = cookieLocale
      ? profileIdForLocale(cookieLocale)
      : getActivePluginProfileId();
    const pluginId = pluginProfileRegistry.getPluginIds(profileId, "content.detail")[0];
    const detail = await getContentDetail(
      { externalRef: { providerId: pluginId, externalId: id } },
      { profileId, timeoutMs: 3_000 }
    );
    const title = preferredText(detail?.titles, locale) || "影片详情";
    const overview = preferredText(detail?.overview, locale);
    const description = overview || `${title}的剧情、评分、演职员及网盘资源信息。`;
    return createPageMetadata({
      title,
      description: description.slice(0, 160),
      path: `/movie/${encodeURIComponent(id)}`,
      image: detail?.preview?.posterUrl,
    });
  } catch (error) {
    console.warn("生成影片 SEO 元数据失败:", error);
    return createPageMetadata({
      title: "影片详情",
      description: "查看电影和电视剧的剧情、评分、演职员及网盘资源信息。",
      path: `/movie/${encodeURIComponent(id)}`,
    });
  }
}

export default function MovieDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
