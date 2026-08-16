/**
 * MongoDB 集合名称常量
 * 
 * 集中管理所有集合名称，避免硬编码
 */

export const COLLECTIONS = {
  /** VOD 视频源配置 */
  VOD_SOURCES: 'vod_sources',
  /** VOD 视频源选择记录 */
  VOD_SOURCE_SELECTION: 'vod_source_selection',
  /** 短剧视频源配置 */
  SHORTS_SOURCES: 'shorts_sources',
  /** 短剧视频源选择记录 */
  SHORTS_SOURCE_SELECTION: 'shorts_source_selection',
  /** Dailymotion 频道列表 */
  DAILYMOTION_CHANNELS: 'dailymotion_channels',
  /** Dailymotion 全局配置 */
  DAILYMOTION_CONFIG: 'dailymotion_config',
  /** 播放器配置 */
  PLAYER_CONFIG: 'player_config',
  /** 网盘资源 */
  PAN_RESOURCES: 'pan_resources',
} as const;

/** 集合名称类型 */
export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];
