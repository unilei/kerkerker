import { NextRequest, NextResponse } from "next/server";
import { listShortDramas } from "@/lib/short-drama-db";
import {
  decodeListCursor,
  encodeListCursor,
  listCursorFromDoc,
  type ListCursor,
} from "@/lib/list-cursor";

/**
 * 短剧公开列表（匿名可读，与既有公开读路由口径一致）
 *
 * GET /api/short-dramas?tag=&search=&page=&limit=
 *   offset 模式：服务端跳页 / 兼容旧调用（页码语义）。
 * GET /api/short-dramas?tag=&search=&after=&limit=
 *   keyset 模式：以上一页响应里的 next_cursor 续页（首页「加载更多」），
 *   翻页期间后台写入不会造成跨页重复/漏项。
 * 两种模式响应统一带 has_more / next_cursor；标签菜单数据见 /api/short-dramas/tags。
 */

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || 24, 100));
  const tag = searchParams.get("tag") || undefined;
  const search = searchParams.get("search") || undefined;
  const page = Number(searchParams.get("page")) || 1;

  // 游标合法性：解码失败直接 400，不能静默退回页首（客户端会拿到重复内容）
  let after: ListCursor | undefined;
  const afterRaw = searchParams.get("after");
  if (afterRaw) {
    after = decodeListCursor(afterRaw) ?? undefined;
    if (!after) {
      return NextResponse.json(
        { code: 400, message: "游标无效", data: null },
        { status: 400 }
      );
    }
  }

  // keyset 模式多取一条判定 has_more；撞上 100 上限时退化为
  // 「取满即有更多」，最多多做一次立刻终止的空页请求
  const fetchLimit = after ? Math.min(limit + 1, 100) : limit;

  try {
    const result = await listShortDramas({
      // 前台只展示转存完成的短剧
      status: "done",
      ...(tag ? { tag } : {}),
      ...(search ? { search } : {}),
      ...(after ? { after } : { page }),
      limit: fetchLimit,
    });

    let dramas = result.dramas;
    let hasMore: boolean;
    if (after) {
      hasMore = dramas.length >= fetchLimit;
      if (hasMore) dramas = dramas.slice(0, limit);
    } else {
      hasMore = result.page * result.limit < result.total;
    }
    const last = dramas.at(-1);

    return NextResponse.json({
      code: 200,
      message: "ok",
      data: {
        dramas: dramas.map(stripInternalFields),
        total: result.total,
        page: result.page,
        limit: result.limit,
        has_more: hasMore,
        next_cursor: last ? encodeListCursor(listCursorFromDoc(last)) : null,
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
