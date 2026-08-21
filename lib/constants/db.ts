/**
 * MongoDB 集合名称常量
 * 
 * 集中管理所有集合名称，避免硬编码
 */

export const COLLECTIONS = {
  /** 宿主内容身份与外部来源 ID 映射 */
  CONTENT_IDENTITIES: 'content_identities',
  /** 网盘资源 */
  PAN_RESOURCES: 'pan_resources',
  /** 网盘资源来源身份迁移的可回滚备份 */
  PAN_RESOURCE_DEDUP_BACKUPS: 'pan_resource_dedup_backups',
  /** 网盘资源来源身份迁移的运行与索引快照 */
  PAN_RESOURCE_DEDUP_RUNS: 'pan_resource_dedup_runs',
  /** 网盘资源 kkpans 同步状态（单例） */
  PAN_SYNC_STATE: 'pan_sync_state',
  /** 站内影片网盘同步台账 */
  PAN_SYNC_TARGETS: 'pan_sync_targets',
  /** 影片网盘同步调度配置（单例） */
  PAN_SYNC_SCHEDULE: 'pan_sync_schedule',
  /** 影片网盘同步运行记录 */
  PAN_SYNC_RUNS: 'pan_sync_runs',
  /** 影片网盘同步运行事件/日志 */
  PAN_SYNC_RUN_EVENTS: 'pan_sync_run_events',
  /** 插件合规审批与运行策略 */
  PLUGIN_POLICIES: 'plugin_policies',
  /** 不可静默覆盖的合规审计事件 */
  AUDIT_EVENTS: 'audit_events',
  /** 内容、资源、插件或来源的下架记录 */
  TAKEDOWN_RECORDS: 'takedown_records',
} as const;

/** 集合名称类型 */
export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];
