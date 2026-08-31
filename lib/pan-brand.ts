/**
 * 网盘品牌识别（短剧抓取用：源站链接品牌判断）
 */

import type { PanBrand } from "@/types/pan-brand";

// 链接域名 → 品牌识别映射（按后缀匹配；短剧站当前只收夸克，
// 保留全量映射便于未来扩展其他网盘源）
const BRAND_DOMAINS: Array<[PanBrand | "baidu" | "xunlei" | "uc" | "guangya", string[]]> = [
  ["quark", ["pan.quark.cn", "quark.cn"]],
  ["baidu", ["pan.baidu.com", "yun.baidu.com"]],
  ["xunlei", ["pan.xunlei.com", "xunlei.com"]],
  ["uc", ["drive.uc.cn", "pcl.uc.cn", "drive.ucweb.com"]],
  ["guangya", ["guangyapan.com"]],
];

export type RecognizedPanBrand = "quark" | "baidu" | "xunlei" | "uc" | "guangya";

/** 根据链接域名识别品牌；未识别返回空串 */
export function detectPanBrand(url: string): RecognizedPanBrand | "" {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [brand, domains] of BRAND_DOMAINS) {
      if (domains.some((d) => host === d || host.endsWith(`.${d}`))) {
        return brand;
      }
    }
  } catch {
    // 非法 URL，视为未识别
  }
  return "";
}
