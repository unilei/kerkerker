/**
 * MongoDB 集合名称常量
 * 
 * 集中管理所有集合名称，避免硬编码
 */

export const COLLECTIONS = {
  /** 网盘资源 */
  PAN_RESOURCES: 'pan_resources',
} as const;

/** 集合名称类型 */
export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];
