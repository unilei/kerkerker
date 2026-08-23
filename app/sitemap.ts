import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";

const PUBLIC_ROUTES = [
  { path: "/", priority: 1, changeFrequency: "daily" as const },
  { path: "/browse/movies", priority: 0.9, changeFrequency: "daily" as const },
  { path: "/browse/tv", priority: 0.9, changeFrequency: "daily" as const },
  { path: "/browse/latest", priority: 0.9, changeFrequency: "daily" as const },
  { path: "/calendar", priority: 0.8, changeFrequency: "daily" as const },
  { path: "/category/top250", priority: 0.8, changeFrequency: "weekly" as const },
  { path: "/category/in_theaters", priority: 0.7, changeFrequency: "daily" as const },
  { path: "/category/hot_movies", priority: 0.7, changeFrequency: "daily" as const },
  { path: "/category/hot_tv", priority: 0.7, changeFrequency: "daily" as const },
  { path: "/category/us_tv", priority: 0.6, changeFrequency: "daily" as const },
  { path: "/category/jp_tv", priority: 0.6, changeFrequency: "daily" as const },
  { path: "/category/kr_tv", priority: 0.6, changeFrequency: "daily" as const },
  { path: "/category/anime", priority: 0.6, changeFrequency: "daily" as const },
  { path: "/category/chinese_tv", priority: 0.6, changeFrequency: "daily" as const },
  { path: "/category/variety", priority: 0.6, changeFrequency: "daily" as const },
  { path: "/category/documentary", priority: 0.6, changeFrequency: "daily" as const },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: absoluteUrl(path),
    priority,
    changeFrequency,
  }));
}
