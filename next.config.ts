import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 启用 standalone 模式以支持 Docker 部署
  output: 'standalone',
  
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
    unoptimized: true,
  },
};

export default nextConfig;
