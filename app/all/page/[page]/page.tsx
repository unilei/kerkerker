import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listShortDramas } from "@/lib/short-drama-db";
import { absoluteUrl, ALL_PAGE_SIZE, createPageMetadata } from "@/lib/seo";
import { PaginationNav } from "@/components/home/PaginationNav";
import ShortDramaCard from "@/components/short-drama/ShortDramaCard";
import { PageShell } from "@/components/home/PageShell";

/**
 * 全部短剧分页索引（服务端组件）：/all/page/[page]，每页 ALL_PAGE_SIZE
 * 部、与 sitemap 同口径（done 且已有自有网盘链接，即 hasOwnShareUrl），
 * 保证 sitemap 输出的页数与实际分页一致。
 *
 * SEO：全部分页均可收录，page 1 起 self-canonical 并输出 prev/next；
 * /all 已 301 到 /all/page/1；超出总页数返回真 404。
 */

export const dynamic = "force-dynamic";

interface AllPageProps {
  params: Promise<{ page: string }>;
}

function pagePath(page: number): string {
  return `/all/page/${page}`;
}

async function loadAllPageData(page: number) {
  return listShortDramas({
    status: "done",
    hasOwnShareUrl: true,
    page,
    limit: ALL_PAGE_SIZE,
  });
}

export async function generateMetadata({
  params,
}: AllPageProps): Promise<Metadata> {
  const { page: rawPage } = await params;
  const page = Number(rawPage);
  // 非法页码交给页面渲染 notFound()，这里只做 noindex 兜底
  if (!Number.isInteger(page) || page < 1 || page > 10_000) {
    return { title: "页面不存在", robots: { index: false, follow: false } };
  }
  const result = await loadAllPageData(page);
  if (page > 1 && page > Math.max(1, Math.ceil(result.total / ALL_PAGE_SIZE))) {
    return { title: "页面不存在", robots: { index: false, follow: false } };
  }
  const title =
    page > 1 ? `全部短剧 第${page}页｜${result.total}部合集` : `全部短剧｜${result.total}部合集`;
  return createPageMetadata({
    title,
    description: `爱盼短剧全部短剧合集：${result.total}部转存可用的短剧，按发布日期排列，附剧情简介与网盘资源入口，一键跳转转存。`,
    path: pagePath(page),
    ...(page > 1 ? { prevPage: pagePath(page - 1) } : {}),
    ...(result.total > page * ALL_PAGE_SIZE ? { nextPage: pagePath(page + 1) } : {}),
  });
}

export default async function AllPage({ params }: AllPageProps) {
  const { page: rawPage } = await params;
  const page = Number(rawPage);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) notFound();

  const result = await loadAllPageData(page);
  const totalPages = Math.max(1, Math.ceil(result.total / ALL_PAGE_SIZE));
  // 超出实际总页数的 URL 返回真 404（sitemap 与本页总页数同口径）
  if (page > totalPages) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: page > 1 ? `全部短剧 第${page}页` : "全部短剧",
    itemListElement: result.dramas.map((drama, index) => ({
      "@type": "ListItem",
      position: (page - 1) * ALL_PAGE_SIZE + index + 1,
      url: absoluteUrl(`/drama/${drama.id}`),
      name: drama.title,
    })),
  };

  return (
    <PageShell>
      <main className="relative z-10 pt-24 px-4 md:px-12 pb-16">
        {/* 可见面包屑（详情页 JSON-LD 面包屑与本页结构对齐） */}
        <nav aria-label="面包屑" className="mb-4 text-sm text-gray-400">
          <Link href="/" className="hover:text-white transition-colors">
            首页
          </Link>
          <span className="mx-1.5 text-gray-600">/</span>
          <span className="text-gray-300">全部短剧</span>
        </nav>

        <h1 className="text-2xl md:text-3xl font-bold text-white mb-2">
          全部短剧
        </h1>
        <p className="text-sm text-gray-400 mb-8">
          共 {result.total} 部可转存的短剧，按发布日期排列，持续更新。
        </p>

        {result.dramas.length === 0 ? (
          <p className="text-gray-400 py-16 text-center">暂无短剧，去首页看看吧。</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 md:gap-4">
            {result.dramas.map((drama) => (
              <ShortDramaCard key={drama.id} drama={drama} priority={false} />
            ))}
          </div>
        )}

        {/* SSR 分页：数字选择器，纯链接，蜘蛛可循链翻页 */}
        <div className="mt-10">
          <PaginationNav
            current={page}
            total={totalPages}
            buildHref={pagePath}
            ariaLabel="分页"
          />
        </div>
      </main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
    </PageShell>
  );
}
