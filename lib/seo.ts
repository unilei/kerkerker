import type { Metadata } from "next";

export const SITE_NAME = "爱盼";
export const SITE_URL = normalizeSiteUrl(
  process.env.NEXT_PUBLIC_SITE_URL || "https://www.aipan.me"
);
export const SEARCH_SITE_URL = "https://search.aipan.me";
export const SITE_DESCRIPTION =
  "爱盼聚合电影与电视剧资料、评分、上映信息和公开网盘资源导航，帮助你更快找到想看的内容。";
export const SITE_IMAGE_URL = absoluteUrl("/logo.png");

function normalizeSiteUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "https://www.aipan.me";
  }
}

export function absoluteUrl(path = "/"): string {
  return new URL(path, `${SITE_URL}/`).toString();
}

export function createPageMetadata(input: {
  title: string;
  description: string;
  path: string;
  image?: string;
  noIndex?: boolean;
}): Metadata {
  const canonical = absoluteUrl(input.path);
  const image = input.image || SITE_IMAGE_URL;

  return {
    title: input.title,
    description: input.description,
    alternates: { canonical },
    robots: input.noIndex
      ? { index: false, follow: false }
      : { index: true, follow: true },
    openGraph: {
      type: "website",
      url: canonical,
      title: input.title,
      description: input.description,
      siteName: SITE_NAME,
      locale: "zh_CN",
      images: [{ url: image, alt: input.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description: input.description,
      images: [image],
    },
  };
}
