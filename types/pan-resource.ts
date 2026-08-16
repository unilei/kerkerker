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
  badgeClass: string; // 徽标背景色（Tailwind class）
  textClass: string; // 品牌文字色（Tailwind class）
}

export const PAN_BRAND_CONFIGS: Record<PanBrand, PanBrandConfig> = {
  quark: {
    key: "quark",
    name: "夸克网盘",
    shortName: "夸",
    badgeClass: "bg-orange-500",
    textClass: "text-orange-400",
  },
  baidu: {
    key: "baidu",
    name: "百度网盘",
    shortName: "百",
    badgeClass: "bg-blue-500",
    textClass: "text-blue-400",
  },
  xunlei: {
    key: "xunlei",
    name: "迅雷云盘",
    shortName: "迅",
    badgeClass: "bg-red-500",
    textClass: "text-red-400",
  },
  guangya: {
    key: "guangya",
    name: "光鸭网盘",
    shortName: "鸭",
    badgeClass: "bg-purple-500",
    textClass: "text-purple-400",
  },
  uc: {
    key: "uc",
    name: "UC网盘",
    shortName: "UC",
    badgeClass: "bg-emerald-500",
    textClass: "text-emerald-400",
  },
};

// 网盘资源（前台展示 / API 返回，驼峰字段）
export interface PanResource {
  id: string;
  douban_id: string;
  internal_id?: number;
  movie_title?: string;
  brand: PanBrand;
  title: string;
  size?: string;
  format?: string;
  url: string;
  note?: string;
  enabled: boolean;
  created_at: string; // ISO 字符串
  updated_at: string; // ISO 字符串
}

// 新增/更新网盘资源的入参
export interface PanResourceInput {
  douban_id?: string;
  internal_id?: number;
  movie_title?: string;
  brand?: PanBrand;
  title?: string;
  size?: string;
  format?: string;
  url?: string;
  note?: string;
  enabled?: boolean;
}
