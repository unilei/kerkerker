import { NextRequest, NextResponse } from "next/server";
import { listShortDramas, listShortDramaTagCounts, getShortDramaTagGroups } from "@/lib/short-drama-db";
import { mergeTagGroupSources } from "@/lib/short-drama/tag-groups";

/**
 * 短剧公开列表（匿名可读，与既有公开读路由口径一致）
 *
 * GET /api/short-dramas?tag=&search=&page=&limit=&with_tags=1
 * 只回转存完成（done）的条目；with_tags=1 时附带按源站分组归类
 * （女性/男性/场景职业/爽设/单字）的标签云数据。
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

    // 标签归类：本地计数按源站分组映射归类；库里没有命中的组不输出；
    // 未归入任何已知分组的标签并入「其他标签」（源站未来新增标签的兜底）
    let tagGroups: Array<{ category: string; tags: Array<{ tag: string; count: number }> }> | undefined;
    if (tagCounts) {
      const stored = await getShortDramaTagGroups();
      const groups = mergeTagGroupSources(stored, null);
      const countByTag = new Map(tagCounts.map((row) => [row.tag, row.count]));
      const assigned = new Set<string>();
      tagGroups = groups
        .map((group) => ({
          category: group.category,
          tags: group.tags
            .filter((tag) => countByTag.has(tag))
            .map((tag) => ({ tag, count: countByTag.get(tag)! })),
        }))
        .filter((group) => group.tags.length > 0);
      for (const group of tagGroups) {
        for (const entry of group.tags) assigned.add(entry.tag);
      }
      const others = tagCounts.filter((row) => !assigned.has(row.tag));
      if (others.length > 0) {
        tagGroups.push({
          category: "其他标签",
          tags: others.map((row) => ({ tag: row.tag, count: row.count })),
        });
      }
    }

    return NextResponse.json({
      code: 200,
      message: "ok",
      data: {
        dramas: result.dramas.map(stripInternalFields),
        total: result.total,
        page: result.page,
        limit: result.limit,
        ...(tagGroups ? { tag_groups: tagGroups } : {}),
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
