import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getShortDramaById,
  listRelatedShortDramas,
} from "@/lib/short-drama-db";
import { parseDramaInfo } from "@/lib/short-drama/drama-info";
import { absoluteUrl, createPageMetadata, tagPath } from "@/lib/seo";
import DramaDetailView, {
  type DramaDetailViewData,
} from "@/components/short-drama/DramaDetailView";

/**
 * 短剧详情页（服务端组件）
 *
 * 数据在服务端直出（剧名/简介/标签进入 HTML 源码，百度等不执行 JS 的
 * 引擎也能收录）；公开口径与 /api/short-dramas/:id 一致：published 且
 * 已有 kkpan 分享链接，否则返回真 404（不再出现 HTTP 200 的软 404）。
 * 相关短剧同标签 SSR 直出：内链纵深 + 蜘蛛横向爬行入口。
 */

export const dynamic = "force-dynamic";

interface DramaDetailPageProps {
  params: Promise<{ id: string }>;
}

const loadPublicDrama = cache(
  async (id: string): Promise<DramaDetailViewData | null> => {
    const drama = await getShortDramaById(id);
    if (!drama || !drama.share_url) return null;
    return {
      id: drama.id,
      title: drama.title,
      episode_count: drama.episode_count,
      tags: drama.tags ?? [],
      cover_url: drama.cover_url,
      intro: drama.intro,
      metadata: drama.metadata,
      share_url: drama.share_url,
      share_code: drama.share_code,
      publish_date: drama.publish_date,
      updated_at: drama.updated_at,
    };
  }
);

function detailDescription(drama: DramaDetailViewData): string {
  const intro = drama.intro?.replace(/\s+/g, " ").trim();
  if (intro) return intro.slice(0, 160);
  const extras = [
    drama.episode_count ? `全${drama.episode_count}集` : "",
    drama.tags.slice(0, 3).join("、"),
  ].filter(Boolean);
  return `《${drama.title}》短剧${extras.length ? `（${extras.join(" · ")}）` : ""}全集资源导航，一键跳转网盘转存。`;
}

export async function generateMetadata({
  params,
}: DramaDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const drama = await loadPublicDrama(id);
  if (!drama) {
    // 页面随后渲染 notFound()，这里只做 noindex 兜底
    return { title: "短剧不存在", robots: { index: false, follow: false } };
  }
  return createPageMetadata({
    title: `${drama.title}${drama.episode_count ? `（全${drama.episode_count}集）` : ""}`,
    description: detailDescription(drama),
    path: `/drama/${drama.id}`,
    image: drama.cover_url,
  });
}

export default async function DramaDetailPage({ params }: DramaDetailPageProps) {
  const { id } = await params;
  const drama = await loadPublicDrama(id);
  if (!drama) notFound();

  // 相关短剧失败不阻塞详情页渲染（尽力而为的内链增强）
  let related: DramaDetailViewData["related"];
  try {
    related = (
      await listRelatedShortDramas(drama.id, drama.tags, 8)
    ).map((item) => ({
      id: item.id,
      title: item.title,
      episode_count: item.episode_count,
      tags: item.tags ?? [],
      cover_url: item.cover_url,
      publish_date: item.publish_date,
    }));
  } catch (error) {
    console.warn("相关短剧加载失败:", error);
    related = [];
  }

  const canonical = absoluteUrl(`/drama/${drama.id}`);
  // 演员信息进 TVSeries actor（metadata 优先，简介文本解析兜底），增强富摘要；
  // 源站把多名演员挤在同一行（「A / B / C」），这里按 / 拆开逐人输出
  const actors = parseDramaInfo(drama.metadata, drama.intro)
    .actors.flatMap((actor) => (actor.name ?? "").split("/"))
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 10);
  // 面包屑三级：首页 > 标签（首个）> 剧名
  const breadcrumbItems = [
    { "@type": "ListItem", position: 1, name: "首页", item: absoluteUrl("/") },
    ...(drama.tags.length > 0
      ? [
          {
            "@type": "ListItem",
            position: 2,
            name: `${drama.tags[0]}短剧`,
            item: absoluteUrl(tagPath(drama.tags[0])),
          },
        ]
      : []),
    {
      "@type": "ListItem",
      position: drama.tags.length > 0 ? 3 : 2,
      name: drama.title,
      item: canonical,
    },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TVSeries",
        name: drama.title,
        url: canonical,
        inLanguage: "zh-CN",
        ...(drama.intro ? { description: drama.intro.slice(0, 300) } : {}),
        ...(drama.cover_url ? { image: drama.cover_url } : {}),
        ...(drama.episode_count ? { numberOfEpisodes: drama.episode_count } : {}),
        ...(drama.publish_date ? { datePublished: drama.publish_date } : {}),
        ...(drama.tags.length > 0 ? { genre: drama.tags } : {}),
        ...(actors.length > 0
          ? { actor: actors.map((name) => ({ "@type": "Person", name })) }
          : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: breadcrumbItems,
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
      <DramaDetailView drama={{ ...drama, related }} />
    </>
  );
}
