import { NextRequest, NextResponse } from "next/server";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/url-security";
import { getShortsSourcesFromDB, getShortsSourceByKey } from "@/lib/shorts-sources-db";
import type { ShortDramaSource } from "@/types/shorts-source";

export interface ShortDrama {
  vod_id: number;
  vod_name: string;
  vod_pic: string;
  vod_remarks: string;
  vod_time: string;
  type_name: string;
}

export interface ShortsListResponse {
  code: number;
  msg: string;
  page: number;
  pagecount: number;
  total: number;
  list: ShortDrama[];
  source: string;
  sources: { key: string; name: string }[];
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = searchParams.get("pg") || "1";
    const sourceKey = searchParams.get("source");

    // 从数据库获取短剧源配置
    let sources: ShortDramaSource[];
    try {
      sources = await getShortsSourcesFromDB();
    } catch {
      sources = [];
    }

    // 如果没有配置短剧源，返回错误
    if (sources.length === 0) {
      return NextResponse.json(
        { code: 404, msg: "暂未配置短剧源，请先在后台添加短剧源", data: null },
        { status: 404 }
      );
    }

    // 获取指定的资源站配置，默认使用第一个
    let source: ShortDramaSource | null = null;
    
    if (sourceKey) {
      try {
        source = await getShortsSourceByKey(sourceKey);
      } catch {
        source = sources.find(s => s.key === sourceKey) || null;
      }
    }

    // 如果没有找到指定的源，使用第一个
    if (!source) {
      source = sources[0];
    }

    // SSRF 防御：即便 source 来自 DB，该接口匿名开放，仍校验对外请求目标
    const safeApiBase = (await assertSafeOutboundUrl(source.api)).toString();

    // 构建 API URL
    let apiUrl = `${safeApiBase}?pg=${page}`;
    if (source.typeId) {
      apiUrl += `&t=${source.typeId}`;
    }

    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      next: { revalidate: 300 }, // 5分钟缓存
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();

    return NextResponse.json({
      code: 200,
      msg: "success",
      data: {
        page: data.page,
        pagecount: data.pagecount,
        total: data.total,
        list: data.list.map((item: any) => ({
          vod_id: item.vod_id,
          vod_name: item.vod_name,
          vod_pic: item.vod_pic || "",
          vod_remarks: item.vod_remarks,
          vod_time: item.vod_time,
          type_name: item.type_name,
        })),
        source: source.key,
        sources: sources.map(s => ({ key: s.key, name: s.name })),
      },
    });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      return NextResponse.json(
        { code: error.status, msg: error.message, data: null },
        { status: error.status }
      );
    }
    console.error("[Shorts List API Error]", error);
    return NextResponse.json(
      { code: 500, msg: "获取短剧列表失败", data: null },
      { status: 500 }
    );
  }
}

