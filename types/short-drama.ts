/**
 * 短剧类型定义
 *
 * 短剧数据来自外部资源源（duanjugou 等）抓取，转存到自己夸克网盘后
 * 与分享夹内的 封面.jpg / metadata.json / 简介.txt 关联。
 * 前台为信息展示 + 网盘导航（合规分支：无在线播放）。
 */

// 支持的短剧资源源
export type ShortDramaSource = "duanjugou";

// 短剧转存状态机：discovered → transferring → done / failed
export type ShortDramaStatus =
  | "discovered" // 已抓取入库，等待转存
  | "transferring" // 转存进行中
  | "done" // 转存完成，元数据已关联
  | "failed" // 转存失败（可重试）
  | "invalid"; // 链接失效 / 无可转存内容

export const SHORT_DRAMA_STATUSES: ShortDramaStatus[] = [
  "discovered",
  "transferring",
  "done",
  "failed",
  "invalid",
];

// 前台展示 / API 返回（驼峰字段）
export interface ShortDrama {
  id: string;
  source: ShortDramaSource;
  /** 源站文章数字 ID，如 81864（同一源内唯一） */
  source_article_id: string;
  /** 清洗后的剧名（去掉集数后缀与 AI短剧 标记） */
  title: string;
  /** 集数（从标题解析，如（98 集）→ 98） */
  episode_count?: number;
  /** 标签（源站标签体系：女性/男性/场景职业/爽设/单字等） */
  tags: string[];
  /** 源站夸克分享链接（原始发现来源） */
  source_share_url?: string;
  /** 转存后自己网盘的分享链接（对外展示用） */
  own_share_url?: string;
  own_share_code?: string;
  /** 自己网盘里转存目录的 fid（元数据读取入口） */
  own_folder_fid?: string;
  /** 封面图（R2 镜像后的稳定 URL） */
  cover_url?: string;
  /** 简介（源站分享夹内 简介.txt） */
  intro?: string;
  /** 元数据（源站分享夹内 metadata.json 原样保留） */
  metadata?: Record<string, unknown>;
  /** 源站发布日期（YYYY-MM-DD） */
  publish_date?: string;
  status: ShortDramaStatus;
  transfer_error?: string;
  transfer_attempts: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// 抓取入库入参
export interface ShortDramaUpsertInput {
  source: ShortDramaSource;
  source_article_id: string;
  title: string;
  episode_count?: number;
  tags?: string[];
  source_share_url?: string;
  publish_date?: string;
}

// 同步状态文档（short_drama_sync_state 集合，单例 id:1）
export interface ShortDramaSyncState {
  /** 增量抓取水位：已见过的最大源文章数字 ID（列表页按时间倒序，命中即停） */
  last_article_watermark?: number;
  last_scrape_at?: string;
  last_scrape_mode?: "backfill" | "incremental";
  last_scrape_stats?: Record<string, unknown>;
  last_transfer_at?: string;
  last_transfer_stats?: Record<string, unknown>;
  last_metadata_backfill_at?: string;
  last_metadata_backfill_stats?: Record<string, unknown>;
  /** 标签归类映射（组名 → 标签[]），由 runTagGroupSync 从源站刷新 */
  tag_groups?: Record<string, string[]>;
  /** 当前运行租约；空闲时为 null（Mongo 语义需要 null 而非缺省） */
  running: {
    task: "scrape" | "transfer";
    started_at: string;
    expires_at: string;
  } | null;
  updated_at: string;
}
