import { NextRequest, NextResponse } from "next/server";
import { listShortDramas, listShortDramaTagCounts } from "@/lib/short-drama-db";

/**
 * 短剧公开列表（匿名可读，与既有公开读路由口径一致）
 *
 * GET /api/short-dramas?tag=&search=&page=&limit=
 * 返回字段见 types/short-drama.ts；只回转存完成（done）的条目给前台，
 * 附带标签聚合计数供标签云。
 */

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const page = Number(searchParams.get("page")) || 1;
  const limit = Number(searchParams.get("limit")) || 24;
  const tag = searchParams.get("tag") || undefined;
  const search = searchParams.get("search") || undefined;
  const withTags = searchParams.get("with_tags") === "1";

  try {
    const [result, tagCounts] = await Promise.all([
      listShortDramas({
        // 前台只展示转存完成的短剧
        status: "done",
        ...(tag ? { tag } : {}),
        ...(search ? { search } : {}),
        page,
        limit,
      }),
      withTags ? listShortDramaTagCounts() : Promise.resolve(undefined),
    ]);

    return NextResponse.json({
      code: 200,
      message: "ok",
      data: {
        dramas: result.dramas.map(stripInternalFields),
        total: result.total,
        page: result.page,
        limit: result.limit,
        ...(tagCounts ? { tag_counts: tagCounts } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "短剧列表读取失败",
        data: null,
      },
      { status: 500 }
    );
  }
}

/** 前台不需要转存过程字段与源站原始链接 */
function stripInternalFields(drama: Awaited<ReturnType<typeof listShortDramas>>["dramas"][number]) {
  return {
    id: drama.id,
    title: drama.title,
    episode_count: drama.episode_count,
    tags: drama.tags,
    cover_url: drama.cover_url,
    intro: drama.intro,
    metadata: drama.metadata,
    own_share_url: drama.own_share_url,
    own_share_code: drama.own_share_code,
    publish_date: drama.publish_date,
    updated_at: drama.updated_at,
  };
}
