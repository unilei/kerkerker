import { NextResponse } from "next/server";
import { listShortDramaTagCounts, getShortDramaTagGroups } from "@/lib/short-drama-db";
import { mergeTagGroupSources } from "@/lib/short-drama/tag-groups";

/**
 * 标签菜单公开数据（匿名可读）
 *
 * GET /api/short-dramas/tags
 * 返回按源站分组归类（女性/男性/场景职业/爽设/单字）的全量标签，
 * 本地有命中计数时附带 count；导航栏二级菜单用。
 * 无 DB 数据时回退构建期快照，保证菜单始终完整。
 */

export async function GET() {
  try {
    const [stored, counts] = await Promise.all([
      getShortDramaTagGroups(),
      listShortDramaTagCounts(),
    ]);
    const countByTag = new Map(counts.map((row) => [row.tag, row.count]));

    const groups = mergeTagGroupSources(stored, null).map((group) => ({
      category: group.category,
      tags: group.tags.map((tag) => ({
        tag,
        ...(countByTag.has(tag) ? { count: countByTag.get(tag)! } : {}),
      })),
    }));

    // 未归入已知分组的本地标签并入「其他标签」（源站新增标签的兜底）
    const assigned = new Set(groups.flatMap((group) => group.tags.map((entry) => entry.tag)));
    const others = counts.filter((row) => !assigned.has(row.tag));
    if (others.length > 0) {
      groups.push({
        category: "其他标签",
        tags: others.map((row) => ({ tag: row.tag, count: row.count })),
      });
    }

    return NextResponse.json({
      code: 200,
      message: "ok",
      data: { tag_groups: groups },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "标签数据读取失败",
        data: null,
      },
      { status: 500 }
    );
  }
}
