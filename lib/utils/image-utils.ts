// 图片处理工具函数

// 默认占位图
const DEFAULT_PLACEHOLDER = '/movie-default-bg.jpg';

// 需要走服务端代理的图床（国内无法直连）
const PROXIED_HOSTS = ['image.tmdb.org', 'themoviedb.org'];

function needsProxy(imageUrl: string): boolean {
  try {
    const { hostname } = new URL(imageUrl);
    return PROXIED_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

/**
 * 智能获取图片URL
 *
 * 豆瓣图片已由 douban-service 镜像到 R2（douban-images.aipan.me），
 * 可直连加载，无需中转；仅国内被墙的图床（TMDB）仍走服务端代理。
 */
export function getImageUrl(imageUrl: string): string {
  // 空URL返回占位图
  if (!imageUrl || imageUrl.trim() === '') {
    return DEFAULT_PLACEHOLDER;
  }
  if (needsProxy(imageUrl)) {
    return `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
  }
  return imageUrl;
}
