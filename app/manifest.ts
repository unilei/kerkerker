import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "爱盼短剧 | 短剧信息与网盘资源导航",
    short_name: "爱盼短剧",
    description: "电影与电视剧资料、评分和网盘资源导航。",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [{ src: "/logo.png", sizes: "192x192", type: "image/png" }],
  };
}
