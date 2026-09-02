import type { MetadataRoute } from "next";
import { absoluteUrl, SITE_URL } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // /admin /api /login 未登录或非公开；?tag= 已 301 到 /tags/，
        // 搜索结果页 noindex——查询串变体不浪费抓取预算
        disallow: ["/admin/", "/api/", "/login", "/*?tag=", "/*?search="],
      },
    ],
    host: SITE_URL,
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
