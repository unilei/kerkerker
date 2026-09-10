import type { Metadata } from "next";
import { listShortDramas } from "@/lib/short-drama-db";
import {
  encodeListCursor,
  listCursorFromDoc,
} from "@/lib/list-cursor";
import {
  absoluteUrl,
  createPageMetadata,
  HOME_PAGE_SIZE,
  SITE_DESCRIPTION,
  SITE_NAME,
} from "@/lib/seo";
import {
  HomePageClient,
  type HomePageInitialData,
} from "@/components/home/HomePageClient";

/**
 * 首页（服务端组件）：首屏列表与筛选词（?tag= / ?search=）在服务端
 * 取数直出，剧名/标题进入 HTML 源码供搜索引擎收录。
 * ?page= 由客户端翻页写入地址栏（跳页 push / 加载更多 replaceState），
 * 返回、前进、刷新时按页码服务端直出对应页，列表不再重置到第 1 页。
 * ?tag= 已 301 到 /tags/[tag]；带筛选词或页码的变体一律 noindex
 * （SEO 分页由 /all、/tags 承担）。
 */

export const dynamic = "force-dynamic";

interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** ?page= 解析：非法/缺省回 1，上下限与 listShortDramas 内部 clamp 对齐 */
function parsePageParam(value: string | string[] | undefined): number {
  const parsed = Number(firstParam(value));
  if (!Number.isInteger(parsed)) return 1;
  return Math.max(1, Math.min(parsed, 10_000));
}

export async function generateMetadata({
  searchParams,
}: HomePageProps): Promise<Metadata> {
  const { tag, search, page: rawPage } = await searchParams;
  const tagKeyword = firstParam(tag);
  const searchKeyword = firstParam(search);
  const page = parsePageParam(rawPage);
  // 有筛选词/页码的首页变体全部 noindex：tag 已有独立落地页 /tags/[tag]，
  // search 结果页是低质查询串页，分页变体与 /all 重复；首页本体 canonical 指自身
  if (searchKeyword) {
    return createPageMetadata({
      // 品牌词前置 + absolute：根路由不吃根布局 title.template
      title: `${SITE_NAME}｜「${searchKeyword}」搜索结果`,
      description: SITE_DESCRIPTION,
      path: "/",
      noIndex: true,
      absoluteTitle: true,
    });
  }
  if (tagKeyword) {
    // ?tag= 已 301 到 /tags/[tag]，这里只兜底非 301 场景（如带其他参数）
    return createPageMetadata({
      title: `${SITE_NAME}｜「${tagKeyword}」标签短剧`,
      description: SITE_DESCRIPTION,
      path: "/",
      noIndex: true,
      absoluteTitle: true,
    });
  }
  if (page > 1) {
    return createPageMetadata({
      title: `${SITE_NAME}｜精选短剧合集 第${page}页`,
      description: SITE_DESCRIPTION,
      path: "/",
      noIndex: true,
      absoluteTitle: true,
    });
  }
  return createPageMetadata({
    // 首页 title 品牌前置（最值钱的标题位放有搜索量的词 + 保品牌词）；
    // 根路由不吃 title.template，用 absolute 完整控制
    title: `${SITE_NAME}｜精选短剧合集`,
    description: SITE_DESCRIPTION,
    path: "/",
    absoluteTitle: true,
  });
}

/** 与公开 API 同口径的列表条目（不外露源站链接与内部字段） */
function toListItem(drama: Awaited<ReturnType<typeof listShortDramas>>["dramas"][number]) {
  return {
    id: drama.id,
    title: drama.title,
    episode_count: drama.episode_count,
    tags: drama.tags ?? [],
    cover_url: drama.cover_url,
    publish_date: drama.publish_date,
  };
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const { tag, search, page: rawPage } = await searchParams;
  const activeTag = firstParam(tag);
  const searchKeyword = firstParam(search);
  const initialPage = parsePageParam(rawPage);

  let initialData: HomePageInitialData | null = null;
  let initialError: string | null = null;
  try {
    // 前台只展示已发布的短剧（db 层默认 published 口径）
    const listArgs = {
      ...(activeTag ? { tag: activeTag } : {}),
      ...(searchKeyword ? { search: searchKeyword } : {}),
      limit: HOME_PAGE_SIZE,
    };
    let result = await listShortDramas({ ...listArgs, page: initialPage });
    // 页码超出实际总页数（内容更新后旧 URL 越界）回退到最后一页，
    // 避免空网格 + 越界页码的分页器
    const totalPages = Math.max(1, Math.ceil(result.total / HOME_PAGE_SIZE));
    if (initialPage > totalPages) {
      result = await listShortDramas({ ...listArgs, page: totalPages });
    }
    // 首屏游标：「加载更多」以末条为锚点 keyset 续页，跨请求不重不漏
    const lastDoc = result.dramas.at(-1) ?? null;
    initialData = {
      dramas: result.dramas.map(toListItem),
      total: result.total,
      page: result.page,
      limit: result.limit,
      has_more: result.page * result.limit < result.total,
      next_cursor: lastDoc
        ? encodeListCursor(listCursorFromDoc(lastDoc))
        : null,
    };
  } catch (error) {
    console.warn("短剧列表服务端加载失败:", error);
    initialError = "网络异常，请稍后重试";
  }

  return (
    <>
      {/*
        CollectionPage/ItemList JSON-LD 只给默认可索引变体（无筛选词、
        无加载失败时），避免给 noindex 页面重复输出结构化数据。
      */}
      {initialData && !activeTag && !searchKeyword && initialPage === 1 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              name: `${SITE_NAME}｜精选短剧合集`,
              url: absoluteUrl("/"),
              inLanguage: "zh-CN",
              mainEntity: {
                "@type": "ItemList",
                itemListElement: initialData.dramas.map((drama, index) => ({
                  "@type": "ListItem",
                  position: index + 1,
                  url: absoluteUrl(`/drama/${drama.id}`),
                  name: drama.title,
                })),
              },
            }).replace(/</g, "\\u003c"),
          }}
        />
      )}
      <HomePageClient
        // 筛选词或页码变化时重挂载，用服务端新数据重置客户端列表状态
        key={`${activeTag ?? ""}|${searchKeyword ?? ""}|${initialPage}`}
        initialData={initialData}
        initialError={initialError}
        activeTag={activeTag}
        initialSearch={searchKeyword}
      />
    </>
  );
}
