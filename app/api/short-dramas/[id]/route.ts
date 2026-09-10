import { NextRequest, NextResponse } from "next/server";
import { getShortDramaById } from "@/lib/short-drama-db";

/**
 * 短剧公开详情（匿名可读）
 *
 * GET /api/short-dramas/:id
 * 只回已发布（published）的条目；其余返回 404（前端引导回列表）。
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  if (!id || id.length > 64 || !/^[0-9a-f]{24}$/i.test(id)) {
    return NextResponse.json(
      { code: 400, message: "短剧 ID 格式无效", data: null },
      { status: 400 }
    );
  }

  try {
    const drama = await getShortDramaById(id);
    if (!drama || !drama.share_url) {
      return NextResponse.json(
        { code: 404, message: "短剧不存在或资源尚未就绪", data: null },
        { status: 404 }
      );
    }

    return NextResponse.json({
      code: 200,
      message: "ok",
      data: {
        id: drama.id,
        title: drama.title,
        episode_count: drama.episode_count,
        tags: drama.tags,
        cover_url: drama.cover_url,
        intro: drama.intro,
        metadata: drama.metadata,
        share_url: drama.share_url,
        share_code: drama.share_code,
        publish_date: drama.publish_date,
        updated_at: drama.updated_at,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "短剧详情读取失败",
        data: null,
      },
      { status: 500 }
    );
  }
}
