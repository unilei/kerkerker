// 图片处理工具函数

// 默认占位图
const DEFAULT_PLACEHOLDER = '/movie-default-bg.jpg';

/**
 * 智能获取图片URL - 通过代理服务器获取图片
 */
export function getImageUrl(imageUrl: string): string {
  // 空URL返回占位图
  if (!imageUrl || imageUrl.trim() === '') {
    return DEFAULT_PLACEHOLDER;
  }
  return `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
}
