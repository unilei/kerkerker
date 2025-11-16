// 图片处理工具函数

/**
 * 智能获取图片URL - 通过代理服务器获取图片
 */
export function getImageUrl(imageUrl: string): string {
  return `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
}
