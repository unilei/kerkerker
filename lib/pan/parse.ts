/**
 * 网盘资源智能粘贴解析
 *
 * 输入为从资源群 / 网站复制的原始文本（一行或多行，可能混杂
 * 资源名、分享链接、提取码、大小、格式），解析为结构化的待录入条目。
 * 纯前端工具函数，无副作用。
 */

import type { PanBrand } from "@/types/pan-resource";

// 待录入条目（brand 为空表示未能识别，需要人工选择）
export interface ParsedPanItem {
  brand: PanBrand | "";
  url: string;
  title: string;
  size?: string;
  format?: string;
  code?: string;
}

// 链接域名 → 品牌识别映射（按后缀匹配）
const BRAND_DOMAINS: Array<[PanBrand, string[]]> = [
  ["quark", ["pan.quark.cn", "quark.cn"]],
  ["baidu", ["pan.baidu.com", "yun.baidu.com"]],
  ["xunlei", ["pan.xunlei.com", "xunlei.com"]],
  ["uc", ["drive.uc.cn", "pcl.uc.cn", "drive.ucweb.com"]],
  ["guangya", ["guangyapan.com"]],
];

const URL_RE = /https?:\/\/[^\s，,、"'）)\]】<>]+/gi;
const URL_TEST_RE = /https?:\/\//i;
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(TB|TiB|GB|GiB|MB|MiB)(?![A-Za-z0-9])/i;
const FORMAT_RE = /\b(MP4|MKV|AVI|MOV|RMVB|WMV|FLV|WEBM|ISO|TS)\b/i;
const CODE_RE =
  /(?:提取码|提取碼|访问码|访问碼|密[码碼]|password|pwd)[：:\s]*([A-Za-z0-9]{3,10})/i;

// 根据链接域名识别品牌
export function detectPanBrand(url: string): PanBrand | "" {
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

// 从链接 URL 参数中提取提取码（百度 ?pwd=xxxx 等）
function extractCodeFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    for (const key of ["pwd", "p", "code"]) {
      const value = parsed.searchParams.get(key);
      if (value && /^[A-Za-z0-9]{3,10}$/.test(value)) {
        return value.toUpperCase();
      }
    }
  } catch {
    // 忽略
  }
  return undefined;
}

// 清洗标题文本：去掉【品牌】包裹、协议残留、品牌引导词和标点
function cleanTitleText(text: string): string {
  return text
    .replace(/【[^】]*】/g, "")
    .replace(/\S*:\/\//g, "")
    .replace(/^(夸克|百度|迅雷|光鸭|uc)?(网盘|云盘)?[：:\s]+/i, "")
    .replace(/(链接|分享|地址|下载|复制)[:：]?\s*$/i, "")
    .replace(/^[\s|\-–—:：、,，]+|[\s|\-–—:：、,，]+$/g, "")
    .trim();
}

// 解析多行粘贴文本，每个链接生成一条待录入条目
export function parsePanText(text: string, movieTitle?: string): ParsedPanItem[] {
  const items: ParsedPanItem[] = [];
  const seenUrls = new Set<string>();
  let prevLine = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      prevLine = "";
      continue;
    }

    const urls = line.match(URL_RE);
    if (!urls) {
      prevLine = line;
      continue;
    }

    for (const rawUrl of urls) {
      // 去掉粘连的尾部标点
      const url = rawUrl.replace(/[.,;，。；、]+$/, "");
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      const urlIndex = line.indexOf(url);
      const brand = detectPanBrand(url);

      // 元信息（大小/格式/提取码）在当前行 + 上一行（仅当上一行不含别的链接）中查找
      const metaContext = URL_TEST_RE.test(prevLine)
        ? line
        : `${prevLine} ${line}`;

      // 标题候选：当前行链接前的文本、上一行（同样要求不含链接），
      // 取清洗后更长、信息量更大的一方
      const sameLineTitle = cleanTitleText(line.slice(0, urlIndex));
      const prevLineTitle = URL_TEST_RE.test(prevLine)
        ? ""
        : cleanTitleText(prevLine);
      let title = "";
      if (sameLineTitle.length >= prevLineTitle.length) {
        title = sameLineTitle;
      } else {
        title = prevLineTitle;
      }

      // 兜底：链接后的文本 → 片名
      if (!title || title.length < 2) {
        const after = cleanTitleText(
          line
            .slice(urlIndex + url.length)
            .replace(CODE_RE, "")
            .replace(/(提取码|访问码|密[码碼])[^A-Za-z0-9]*.*$/i, "")
        );
        title = after.length >= 2 ? after : movieTitle || "未命名资源";
      }

      const sizeMatch = metaContext.match(SIZE_RE);
      const formatMatch = metaContext.match(FORMAT_RE);
      const codeMatch = metaContext.match(CODE_RE);

      items.push({
        brand,
        url,
        title: title.slice(0, 100),
        size: sizeMatch
          ? `${sizeMatch[1]}${sizeMatch[2].toUpperCase()}`
          : undefined,
        format: formatMatch ? formatMatch[1].toUpperCase() : undefined,
        code:
          (codeMatch ? codeMatch[1].toUpperCase() : undefined) ||
          extractCodeFromUrl(url),
      });
    }

    prevLine = line;
  }

  return items;
}
