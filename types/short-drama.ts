/**
 * 短剧类型定义
 *
 * 短剧条目与夸克分享链接来自 kkpan（同站长的另一个项目）的公开 API，
 * 通过条目同步写入本地；封面/简介/metadata 三件套由元数据同步从 kkpan
 * 的分享目录采集（封面 R2 镜像）。
 * 前台为信息展示 + 网盘导航（合规分支：无在线播放）。
 */

// 支持的短剧资源源
export type ShortDramaSource = "kkpan";

// 元数据三件套（封面/简介/metadata.json）的部件标识
export type ShortDramaMetadataPiece = "cover" | "intro" | "metadata";

// 短剧状态机（两态）：条目同步负责在两态间流转
export type ShortDramaStatus =
  | "published" // kkpan 侧公开可见，详情页可访问
  | "offline"; // kkpan 侧已消失/下架，前台不可见（保留记录便于复活）

export const SHORT_DRAMA_STATUSES: ShortDramaStatus[] = ["published", "offline"];

// 前台展示 / API 返回（蛇形字段，与 collection 文档一致）
export interface ShortDrama {
  id: string;
  source: ShortDramaSource;
  /** kkpan resources.id（信息性字段；文档身份键是 content_key） */
  source_article_id: string;
  /**
   * 归一化剧名键（剥平台标签/集数/空白后小写），同一部剧跨同步轮次、
   * 跨 kkpan 行变化的稳定身份；upsert 按 (source, content_key) 匹配
   */
  content_key: string;
  /** 清洗后的剧名（剥网盘平台标签与集数后缀） */
  title: string;
  /** 集数（从标题的 更新至N集/全N集/（N集） 解析） */
  episode_count?: number;
  /** 标签（kkpan 无标签体系，恒空数组；字段与前台标签 UI 暂时保留） */
  tags: string[];
  /** kkpan 自有夸克分享链接（对外展示 + 访客扫码转存 + 元数据采集入口） */
  share_url: string;
  /** 分享提取码（kkpan 转存任务的 share_code） */
  share_code?: string;
  /** 封面图（R2 镜像后的稳定 URL；未采集到时前台占位图兜底） */
  cover_url?: string;
  /** 简介（分享夹内 简介.txt；条目同步时以 kkpan description 兜底首填） */
  intro?: string;
  /** 元数据（分享夹内 metadata.json 原样保留） */
  metadata?: Record<string, unknown>;
  /**
   * 已确认 kkpan 转存目录里不存在的三件套部件（元数据同步列目录核实后
   * 写入）。写入后该部件不再进入元数据同步队列——源目录本就没有，
   * 重试永远无果。目录列表异常（无视频佐证）时不写，留给下轮重试。
   */
  missing_at_source?: ShortDramaMetadataPiece[];
  /** 最近更新日期（取 kkpan resources.updated_at，YYYY-MM-DD；前台排序键） */
  publish_date?: string;
  status: ShortDramaStatus;
  created_at: string;
  updated_at: string;
}

// 条目同步入库入参（kkpan-sync 产出）
export interface ShortDramaUpsertInput {
  source: ShortDramaSource;
  source_article_id: string;
  content_key: string;
  title: string;
  episode_count?: number;
  share_url: string;
  share_code?: string;
  /** kkpan description（仅在首次创建时作为 intro 兜底，避免覆盖已采集的简介.txt） */
  description?: string;
  publish_date?: string;
}

// 同步状态文档（short_drama_sync_state 集合，单例 id:1）
export interface ShortDramaSyncState {
  last_entries_sync_at?: string;
  last_entries_sync_stats?: Record<string, unknown>;
  last_metadata_sync_at?: string;
  last_metadata_sync_stats?: Record<string, unknown>;
  /** 标签归类映射（组名 → 标签[]），历史 duanjugou 数据快照，前台标签菜单用 */
  tag_groups?: Record<string, string[]>;
  /** 元数据同步长任务租约（单槽；条目同步是快速同步请求不需要租约） */
  running_sync: ShortDramaTaskLease | null;
  updated_at: string;
}

/** 元数据同步任务租约（running_sync 槽位内容） */
export interface ShortDramaTaskLease {
  task: "metadata-sync";
  started_at: string;
  expires_at: string;
  /** 取消请求：由取消 API 置位，任务循环在检查点看到后优雅收尾 */
  cancel_requested?: boolean;
  /** 实时进度：任务执行中定期写入，管理端轮询 GET 读取 */
  progress?: {
    /** 机器可读阶段名（metadata_sync） */
    stage: string;
    /** 一句话进度说明（已含当前条目等细节，直接展示） */
    message: string;
    /** 可选计数型进度：total 缺省或未知时进度条退化为不定态 */
    done?: number;
    total?: number;
    updated_at: string;
  } | null;
}
