import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "追剧日历",
  description: "查看电影与电视剧的最新播出安排和剧集更新日历。",
  path: "/calendar",
});

export default function CalendarLayout({ children }: { children: React.ReactNode }) {
  return children;
}
