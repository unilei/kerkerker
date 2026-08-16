/**
 * MongoDB 集合名称常量
 * 
 * 集中管理所有集合名称，避免硬编码
 */

export const COLLECTIONS = {
  /** 网盘资源 */
  PAN_RESOURCES: 'pan_resources',
  /** 网盘资源 kkpans 同步状态（单例） */
  PAN_SYNC_STATE: 'pan_sync_state',
} as const;

/** 集合名称类型 */
export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];
