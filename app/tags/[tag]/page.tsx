import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listShortDramas, listPublicShortDramaTagCounts } from "@/lib/short-drama-db";
import {
  createPageMetadata,
  tagPath,
  TAG_INDEX_MIN_COUNT,
} from "@/lib/seo";
import ShortDramaCard from "@/components/short-drama/ShortDramaCard";
import { PaginationNav } from "@/components/home/PaginationNav";
import { PageShell } from "@/components/home/PageShell";

/**
 * 标签落地页（服务端组件）：/tags/[tag]，tag 为标签中文名
 * （encodeURIComponent 进 URL，与 ?tag= 同词同取数口径）。
 *
 * SEO：count ≥ TAG_INDEX_MIN_COUNT 的标签可收录；低于门槛 noindex、
 * follow（标题照常给），避免批量薄页面触发低质算法。分页 self-canonical
 * 并输出 prev/next；?tag= 旧链接已 301 到本页。
 */

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

interface TagPageProps {
  params: Promise<{ tag: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function resolveTag(rawTag: string): Promise<string | null> {
  const tag = decodeURIComponent(rawTag).trim().slice(0, 40);
  if (!tag) return null;
  // 未收录的标签词直接 404（防任意词生成空页面）
  const counts = await listPublicShortDramaTagCounts(300);
  if (!counts.some((row) => row.tag === tag)) return null;
  return tag;
}

async function loadTagData(tag: string, page: number) {
  const [result, counts] = await Promise.all([
    listShortDramas({ status: "done", tag, page, limit: PAGE_SIZE }),
    listPublicShortDramaTagCounts(300),
  ]);
  return { result, count: counts.find((row) => row.tag === tag)?.count ?? 0 };
}

export async function generateMetadata({
  params,
  searchParams,
}: TagPageProps): Promise<Metadata> {
  const { tag: rawTag } = await params;
  const { page: rawPage } = await searchParams;
  const tag = await resolveTag(rawTag);
  if (!tag) {
    return { title: "标签不存在", robots: { index: false, follow: false } };
  }
  const page = Math.max(1, Number(firstParam(rawPage)) || 1);
  const { count } = await loadTagData(tag, page);
  const belowThreshold = count < TAG_INDEX_MIN_COUNT;
  // 站名后缀由根布局 title 模板（%s | 爱盼短剧）统一拼接，这里不再手写
  const title =
    page > 1
      ? `${tag}短剧大全 第${page}页｜${count}部推荐`
      : `${tag}短剧大全｜${count}部推荐`;
  return createPageMetadata({
    title,
    description: `爱盼短剧「${tag}」标签合集：${count}部转存可用的${tag}题材短剧，按发布日期排列，附剧情简介与网盘资源入口，一键跳转转存。`,
    path: page > 1 ? `${tagPath(tag)}?page=${page}` : tagPath(tag),
    noIndex: belowThreshold,
    ...(page > 1 ? { prevPage: page === 2 ? tagPath(tag) : `${tagPath(tag)}?page=${page - 1}` } : {}),
    ...(count > page * PAGE_SIZE ? { nextPage: `${tagPath(tag)}?page=${page + 1}` } : {}),
  });
}

export default async function TagPage({ params, searchParams }: TagPageProps) {
  const { tag: rawTag } = await params;
  const { page: rawPage } = await searchParams;
  const tag = await resolveTag(rawTag);
  if (!tag) notFound();

  const page = Math.max(1, Math.min(Number(firstParam(rawPage)) || 1, 10_000));
  const { result, count } = await loadTagData(tag, page);
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  return (
    <PageShell>
      <main className="relative z-10 pt-24 px-4 md:px-12 pb-16">
        {/* 可见面包屑（详情页 JSON-LD 面包屑与本页结构对齐） */}
        <nav aria-label="面包屑" className="mb-4 text-sm text-gray-400">
          <Link href="/" className="hover:text-white transition-colors">
            首页
          </Link>
          <span className="mx-1.5 text-gray-600">/</span>
          <span className="text-gray-300">{tag}</span>
        </nav>

        <h1 className="text-2xl md:text-3xl font-bold text-white mb-2">
          {tag}短剧大全
        </h1>
        <p className="text-sm text-gray-400 mb-8">
          共 {count} 部可转存的{tag}题材短剧，按发布日期排列，持续更新。
        </p>

        {result.dramas.length === 0 ? (
          <p className="text-gray-400 py-16 text-center">该标签下暂无短剧，去首页看看吧。</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 md:gap-4">
            {result.dramas.map((drama) => (
              <ShortDramaCard key={drama.id} drama={drama} priority={false} />
            ))}
          </div>
        )}

        {/* SSR 分页：数字选择器，纯链接，蜘蛛可循链翻页（第 2 页折叠回基础路径） */}
        <div className="mt-10">
          <PaginationNav
            current={page}
            total={totalPages}
            buildHref={(target) =>
              target === 1 ? tagPath(tag) : `${tagPath(tag)}?page=${target}`
            }
            ariaLabel="分页"
          />
        </div>

        {/* 同组相关标签：目录内链，帮助蜘蛛横向爬行 */}
        <RelatedTagLinks currentTag={tag} />
      </main>
    </PageShell>
  );
}

async function RelatedTagLinks({ currentTag }: { currentTag: string }) {
  const counts = await listPublicShortDramaTagCounts(300);
  const related = counts
    .filter((row) => row.tag !== currentTag)
    .slice(0, 23);
  if (related.length === 0) return null;

  return (
    <section className="mt-14 border-t border-white/10 pt-8">
      <h2 className="text-sm font-bold text-gray-300 mb-4">其他热门标签</h2>
      <div className="flex flex-wrap gap-2">
        {related.map(({ tag }) => (
          <Link
            key={tag}
            href={tagPath(tag)}
            className="px-3 py-1.5 rounded-full bg-white/5 text-gray-300 text-sm hover:bg-white/10 hover:text-white transition-colors"
          >
            {tag}
          </Link>
        ))}
      </div>
    </section>
  );
}
