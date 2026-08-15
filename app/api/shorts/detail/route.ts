import { NextRequest, NextResponse } from "next/server";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/url-security";
import {
  getShortsSourcesFromDB,
  getShortsSourceByKey,
} from "@/lib/shorts-sources-db";
import type { ShortDramaSource } from "@/types/shorts-source";

export interface Episode {
  name: string;
  url: string;
}

export interface ShortDramaDetail {
  vod_id: number;
  vod_name: string;
  vod_pic: string;
  vod_remarks: string;
  vod_blurb: string;
  vod_actor: string;
  vod_director: string;
  vod_area: string;
  vod_year: string;
  type_name: string;
  episodes: Episode[];
  source: string;
}

// 解析播放地址字符串
// 格式: "第1集$url1#第2集$url2#第3集$url3" 或 "01$url1#02$url2"
function parsePlayUrl(playUrl: string): Episode[] {
  if (!playUrl) return [];

  const episodes: Episode[] = [];
  const parts = playUrl.split("#");

  for (const part of parts) {
    if (!part.trim()) continue;
    const [name, url] = part.split("$");
    if (name && url) {
      episodes.push({ name: name.trim(), url: url.trim() });
    }
  }

  return episodes;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const ids = searchParams.get("ids");
    const sourceKey = searchParams.get("source");

    if (!ids) {
      return NextResponse.json(
        { code: 400, msg: "缺少 ids 参数", data: null },
        { status: 400 }
      );
    }

    // 获取资源站配置
    let source: ShortDramaSource | null = null;

    if (sourceKey) {
      source = await getShortsSourceByKey(sourceKey);
    }

    // 如果没有找到指定的源，尝试获取第一个可用的源
    if (!source) {
      const sources = await getShortsSourcesFromDB();
      if (sources.length === 0) {
        return NextResponse.json(
          { code: 404, msg: "暂未配置短剧源", data: null },
          { status: 404 }
        );
      }
      source = sources[0];
    }

    // SSRF 防御：即便 source 来自 DB，该接口匿名开放，仍校验对外请求目标
    const safeApiBase = (await assertSafeOutboundUrl(source.api)).toString();
    const apiUrl = `${safeApiBase}?ac=detail&ids=${ids}`;

    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      next: { revalidate: 3600 }, // 1小时缓存
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();

    if (!data.list || data.list.length === 0) {
      return NextResponse.json(
        { code: 404, msg: "短剧不存在", data: null },
        { status: 404 }
      );
    }

    const item = data.list[0];
    const episodes = parsePlayUrl(item.vod_play_url);

    const detail: ShortDramaDetail = {
      vod_id: item.vod_id,
      vod_name: item.vod_name,
      vod_pic: item.vod_pic || "",
      vod_remarks: item.vod_remarks || "",
      vod_blurb: item.vod_blurb || "",
      vod_actor: item.vod_actor || "",
      vod_director: item.vod_director || "",
      vod_area: item.vod_area || "",
      vod_year: item.vod_year || "",
      type_name: item.type_name || "",
      episodes: episodes,
      source: source.key,
    };

    return NextResponse.json({
      code: 200,
      msg: "success",
      data: detail,
    });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      return NextResponse.json(
        { code: error.status, msg: error.message, data: null },
        { status: error.status }
      );
    }
    console.error("[Shorts Detail API Error]", error);
    return NextResponse.json(
      { code: 500, msg: "获取短剧详情失败", data: null },
      { status: 500 }
    );
  }
}
