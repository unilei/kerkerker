import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

const PAGE_METADATA: Readonly<Record<string, { title: string; description: string }>> = {
  movies: {
    title: "电影",
    description: "浏览电影分类、评分、上映信息和影片详情。",
  },
  tv: {
    title: "电视剧",
    description: "浏览电视剧、剧集信息、评分和最新更新内容。",
  },
  latest: {
    title: "最新影视",
    description: "查看最新上线的电影和电视剧内容。",
  },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}): Promise<Metadata> {
  const { type } = await params;
  const content = PAGE_METADATA[type] || {
    title: "影视浏览",
    description: "浏览电影和电视剧内容。",
  };
  return createPageMetadata({ ...content, path: `/browse/${type}` });
}

export default function BrowseTypeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
