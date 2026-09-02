/**
 * MongoDB 集合名称常量
 *
 * 集中管理所有集合名称，避免硬编码
 */

export const COLLECTIONS = {
  /** 短剧库（抓取 + 转存关联） */
  SHORT_DRAMAS: 'short_dramas',
  /** 短剧抓取/转存状态（单例） */
  SHORT_DRAMA_SYNC_STATE: 'short_drama_sync_state',
  /** 网盘凭证（AES 加密存储，含夸克 cookie） */
  CLOUD_CREDENTIALS: 'cloud_credentials',
  /** 访客夸克凭证（扫码登录，AES 加密存储，带 TTL） */
  USER_QUARK_CREDENTIALS: 'user_quark_credentials',
} as const;

/** 集合名称类型 */
export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];
