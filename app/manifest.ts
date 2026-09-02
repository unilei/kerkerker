import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "爱盼短剧 | 短剧信息与网盘资源导航",
    short_name: "爱盼短剧",
    description: "短剧信息聚合与网盘资源导航，按标签找剧，一键跳转网盘转存。",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [{ src: "/logo.png", sizes: "192x192", type: "image/png" }],
  };
}
