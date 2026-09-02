import type { Metadata } from "next";
import Link from "next/link";
import { listPublicShortDramaTagCounts } from "@/lib/short-drama-db";
import {
  createPageMetadata,
  tagPath,
  TAG_INDEX_MIN_COUNT,
} from "@/lib/seo";
import { TAG_MENU_GROUPS } from "@/lib/short-drama/tag-menu";
import { PageShell } from "@/components/home/PageShell";

/**
 * 标签目录页（服务端组件）：全站标签的入口页，按菜单分组归类展示
 * 公开口径（done）计数。只内链 count ≥ TAG_INDEX_MIN_COUNT 的标签，
 * 低于门槛的标签页是 noindex 的薄页，不喂内链权重。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = createPageMetadata({
  // 站名后缀由根布局 title 模板统一拼接
  title: "短剧分类大全｜按标签找剧",
  description:
    "爱盼短剧全部分类导航：女频、男频、题材、爽点等标签分类浏览短剧，霸总、战神、穿越、逆袭等热门题材一键直达。",
  path: "/tags",
});

export default async function TagsIndexPage() {
  const counts = await listPublicShortDramaTagCounts(300);
  const countByTag = new Map(counts.map((row) => [row.tag, row.count]));

  // 已知分组（快照）+ 库内新增标签（未归入已知分组的兜底「更多标签」）
  const assigned = new Set(
    TAG_MENU_GROUPS.flatMap((group) => group.tags)
  );
  const extraTags = counts
    .filter((row) => !assigned.has(row.tag))
    .map((row) => row.tag);

  const groups = [
    ...TAG_MENU_GROUPS.map((group) => ({
      label: group.label,
      tags: group.tags.filter((tag) => (countByTag.get(tag) ?? 0) > 0),
    })),
    ...(extraTags.length > 0 ? [{ label: "更多标签", tags: extraTags }] : []),
  ].filter((group) => group.tags.length > 0);

  return (
    <PageShell>
      <main className="relative z-10 pt-24 px-4 md:px-12 pb-16 max-w-5xl">
        <h1 className="text-2xl md:text-3xl font-bold text-white mb-2">
          短剧分类大全
        </h1>
        <p className="text-sm text-gray-400 mb-10">
          按标签浏览短剧合集，共 {counts.length} 个分类。
        </p>

        {groups.map((group) => (
          <section key={group.label} className="mb-10">
            <h2 className="text-sm font-bold text-gray-300 mb-4">{group.label}</h2>
            <div className="flex flex-wrap gap-2">
              {group.tags.map((tag) => {
                const count = countByTag.get(tag) ?? 0;
                const indexable = count >= TAG_INDEX_MIN_COUNT;
                return (
                  <Link
                    key={tag}
                    href={tagPath(tag)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm transition-colors ${
                      indexable
                        ? "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
                        : "bg-white/[0.03] text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {tag}
                    <span className="text-[10px] opacity-60 tabular-nums">{count}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </main>
    </PageShell>
  );
}
