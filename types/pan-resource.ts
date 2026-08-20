/**
 * 网盘资源类型定义
 *
 * 网盘资源按豆瓣 ID 关联影片详情页（/movie/[id]），
 * internal_id 为豆瓣服务内部自增 ID，作为跨源稳定关联键（可选）。
 */

// 支持的网盘品牌
export type PanBrand = "quark" | "baidu" | "xunlei" | "guangya" | "uc";

// 品牌展示顺序
export const PAN_BRANDS: PanBrand[] = [
  "quark",
  "baidu",
  "xunlei",
  "guangya",
  "uc",
];

// 品牌展示配置
export interface PanBrandConfig {
  key: PanBrand;
  name: string; // 完整名称
  shortName: string; // 徽标内字符
  badgeClass: string; // 兜底徽标背景色（Tailwind class，icon 加载失败时使用）
  textClass: string; // 品牌文字色（Tailwind class）
  icon?: string; // 官方 logo（自托管于 public/pan-icons/）
}

export const PAN_BRAND_CONFIGS: Record<PanBrand, PanBrandConfig> = {
  quark: {
    key: "quark",
    name: "夸克网盘",
    shortName: "夸",
    badgeClass: "bg-orange-500",
    textClass: "text-orange-400",
    icon: "/pan-icons/quark.png",
  },
  baidu: {
    key: "baidu",
    name: "百度网盘",
    shortName: "百",
    badgeClass: "bg-blue-500",
    textClass: "text-blue-400",
    icon: "/pan-icons/baidu.png",
  },
  xunlei: {
    key: "xunlei",
    name: "迅雷云盘",
    shortName: "迅",
    badgeClass: "bg-red-500",
    textClass: "text-red-400",
    icon: "/pan-icons/xunlei.png",
  },
  guangya: {
    key: "guangya",
    name: "光鸭网盘",
    shortName: "鸭",
    badgeClass: "bg-purple-500",
    textClass: "text-purple-400",
    icon: "/pan-icons/guangya.png",
  },
  uc: {
    key: "uc",
    name: "UC网盘",
    shortName: "UC",
    badgeClass: "bg-emerald-500",
    textClass: "text-emerald-400",
    icon: "/pan-icons/uc.png",
  },
};

// 网盘资源（前台展示 / API 返回，驼峰字段）
export interface PanResource {
  id: string;
  douban_id: string;
  /** Host identity introduced by the plugin migration; douban_id remains a compatibility key. */
  content_id?: string;
  internal_id?: number;
  movie_title?: string;
  brand: PanBrand;
  title: string;
  size?: string;
  format?: string;
  url: string;
  code?: string; // 提取码（如 4 位字母数字）
  note?: string;
  source?: PanResourceSource; // 录入来源
  provider_id?: string; // 统一插件来源 ID
  provider_resource_id?: string; // 来源插件内稳定资源 ID
  kkpan_id?: number; // kkpans 资源 ID（同步去重 / 对账用）
  enabled: boolean;
  created_at: string; // ISO 字符串
  updated_at: string; // ISO 字符串
}

// 资源录入来源
export type PanResourceSource = "manual" | "kkpan";

// 新增/更新网盘资源的入参
export interface PanResourceInput {
  douban_id?: string;
  content_id?: string;
  internal_id?: number;
  movie_title?: string;
  brand?: PanBrand;
  title?: string;
  size?: string;
  format?: string;
  url?: string;
  code?: string;
  /** 管理端/同步内部使用：清除已有提取码，而不是写入空字符串。 */
  clear_code?: boolean;
  note?: string;
  source?: PanResourceSource;
  provider_id?: string;
  provider_resource_id?: string;
  kkpan_id?: number;
  enabled?: boolean;
}
