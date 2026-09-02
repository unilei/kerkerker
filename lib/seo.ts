import type { Metadata } from "next";

export const SITE_NAME = "爱盼短剧";
export const SITE_URL = normalizeSiteUrl(
  process.env.NEXT_PUBLIC_SITE_URL || "https://www.aipan.me"
);
export const SEARCH_SITE_URL = "https://search.aipan.me";
export const SITE_DESCRIPTION =
  "爱盼短剧聚合全网短剧信息与网盘资源导航，按标签找剧，一键跳转网盘转存。";
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

/** 标签落地页路径（全站统一入口，/?tag= 已 301 到这里） */
export function tagPath(tag: string): string {
  return `/tags/${encodeURIComponent(tag)}`;
}

/** 标签低于该数量时落地页 noindex，防薄内容触发搜索引擎低质惩罚 */
export const TAG_INDEX_MIN_COUNT = 5;

/**
 * /all 全部短剧分页页每页条数。页面文件不允许自定义命名导出，
 * 该常量放这里供 app/all/page/[page] 与 sitemap 共用（保证
 * sitemap 输出的页数与实际分页一致）。
 */
export const ALL_PAGE_SIZE = 50;

/**
 * 首页海报墙每页条数。必须是「非客户端模块」里的普通常量：
 * 服务端组件从 "use client" 模块导入运行时值会拿到 client-reference
 * 代理（算术运算得 NaN，曾导致首页 SSR 无限拉取全量数据）。
 */
export const HOME_PAGE_SIZE = 24;

export function createPageMetadata(input: {
  title: string;
  description: string;
  path: string;
  image?: string;
  noIndex?: boolean;
  /**
   * 标题整体绝对化（`{ absolute }`）。根路由（app/page.tsx 与根布局同层）
   * 不吃 title.template——Next 会跳过同层的 leaf layout/page 的模板收集，
   * 需要自定义完整标题（如品牌前置）时用这个开关。
   */
  absoluteTitle?: boolean;
  /** 分页 link rel prev/next（标签页与 /all 分页用；undefined 时不输出） */
  prevPage?: string;
  nextPage?: string;
}): Metadata {
  const canonical = absoluteUrl(input.path);
  const image = input.image || SITE_IMAGE_URL;

  return {
    title: input.absoluteTitle
      ? { absolute: input.title }
      : input.title,
    description: input.description,
    alternates: {
      canonical,
    },
    // Next 16 的分页 link rel 在顶层 pagination 键（alternates.previous/next
    // 已不再输出 <link rel="prev/next">）
    ...(input.prevPage || input.nextPage
      ? {
          pagination: {
            ...(input.prevPage ? { previous: absoluteUrl(input.prevPage) } : {}),
            ...(input.nextPage ? { next: absoluteUrl(input.nextPage) } : {}),
          },
        }
      : {}),
    robots: input.noIndex
      ? { index: false, follow: true }
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
