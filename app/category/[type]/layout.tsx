import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

const CATEGORY_METADATA: Readonly<Record<string, { title: string; description: string }>> = {
  in_theaters: { title: "豆瓣热映", description: "查看当前热映电影和热门影视内容。" },
  top250: { title: "Top 250", description: "浏览高评分电影榜单和影片详情。" },
  hot_movies: { title: "热门电影", description: "查看热门电影分类和评分信息。" },
  hot_tv: { title: "热门电视剧", description: "查看热门电视剧和剧集信息。" },
  us_tv: { title: "美剧", description: "浏览美国电视剧和热门剧集。" },
  jp_tv: { title: "日剧", description: "浏览日本电视剧和热门剧集。" },
  kr_tv: { title: "韩剧", description: "浏览韩国电视剧和热门剧集。" },
  anime: { title: "日本动画", description: "浏览日本动画电影和动画剧集。" },
  chinese_tv: { title: "国产剧", description: "浏览国产电视剧和热门剧集。" },
  variety: { title: "综艺", description: "浏览综艺节目和相关内容。" },
  documentary: { title: "纪录片", description: "浏览纪录片和相关影视内容。" },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}): Promise<Metadata> {
  const { type } = await params;
  const content = CATEGORY_METADATA[type] || {
    title: "影视分类",
    description: "浏览电影和电视剧分类内容。",
  };
  return createPageMetadata({ ...content, path: `/category/${type}` });
}

export default function CategoryTypeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
