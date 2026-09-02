import type { MetadataRoute } from "next";
import { absoluteUrl, ALL_PAGE_SIZE, tagPath, TAG_INDEX_MIN_COUNT } from "@/lib/seo";
import {
  listShortDramaSitemapEntries,
  listPublicShortDramaTagCounts,
} from "@/lib/short-drama-db";

/**
 * 动态 sitemap：首页 + 全部短剧分页页 + 标签目录/落地页 + 全部可公开
 * 访问的短剧详情页（done 且已有自有网盘链接）。count ≥
 * TAG_INDEX_MIN_COUNT 的标签页才入图（低于门槛的页面是 noindex 薄页）；
 * 列表接口/搜索查询串不输出。
 */
// 每次请求实时生成；若不加，构建期会预渲染成只有首页的静态结果
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), priority: 1, changeFrequency: "hourly" },
    { url: absoluteUrl("/tags"), priority: 0.8, changeFrequency: "daily" },
  ];

  try {
    const dramas = await listShortDramaSitemapEntries();
    // 全部短剧分页页：与 /all/page/[page] 同口径（条数一致）计算总页数
    const allPages = Math.max(1, Math.ceil(dramas.length / ALL_PAGE_SIZE));
    for (let page = 1; page <= allPages; page++) {
      entries.push({
        url: absoluteUrl(`/all/page/${page}`),
        priority: 0.8,
        changeFrequency: "daily",
      });
    }
    for (const drama of dramas) {
      entries.push({
        url: absoluteUrl(`/drama/${drama.id}`),
        // updated_at 每次流水线回写都有值；缺失时兜底 publish_date（同为 ISO 日期串）
        lastModified: drama.updated_at
          ? new Date(drama.updated_at)
          : drama.publish_date
            ? new Date(drama.publish_date)
            : undefined,
        priority: 0.7,
        changeFrequency: "weekly",
      });
    }
  } catch (error) {
    // 数据库不可用时仍输出首页，避免 sitemap 整体 500
    console.warn("sitemap 短剧条目读取失败:", error);
  }

  try {
    // 标签落地页：与公开详情页同口径计数，达到索引门槛才入图
    const tagCounts = await listPublicShortDramaTagCounts(300);
    for (const { tag, count } of tagCounts) {
      if (count >= TAG_INDEX_MIN_COUNT) {
        entries.push({
          url: absoluteUrl(tagPath(tag)),
          priority: 0.8,
          changeFrequency: "daily",
        });
      }
    }
  } catch (error) {
    console.warn("sitemap 标签条目读取失败:", error);
  }

  return entries;
}
