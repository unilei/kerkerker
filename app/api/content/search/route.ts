import { NextRequest, NextResponse } from "next/server";
import {
  createProfileInvocation,
  getRequestPluginProfileId,
  invokeProfilePlugin,
  type ContentCandidate,
  type PluginPage,
} from "@/lib/plugins";

function preferredTitle(candidate: ContentCandidate, locale: string): string {
  const exact = candidate.titles.find((item) => item.locale.toLowerCase() === locale.toLowerCase());
  return exact?.value || candidate.titles[0]?.value || "";
}

/** Public host boundary for profile-selected content search. */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() || "";
  if (!query) {
    return NextResponse.json({ code: 400, message: "缺少 q 参数", data: null }, { status: 400 });
  }
  if (query.length > 200) {
    return NextResponse.json({ code: 400, message: "q 最长 200 个字符", data: null }, { status: 400 });
  }

  try {
    const profileId = getRequestPluginProfileId(request);
    const { context } = createProfileInvocation({
      profileId,
      capability: "content.search",
      signal: request.signal,
      timeoutMs: 15_000,
    });
    const page = await invokeProfilePlugin<PluginPage<ContentCandidate>>({
      profileId,
      capability: "content.search",
      operation: "search",
      context,
      request: { query, limit: 30 },
    });
    const items = page.items.flatMap((candidate) => {
      const external = candidate.externalRefs[0];
      const title = preferredTitle(candidate, context.locale);
      if (!external || !title) return [];
      return [{
        id: external.externalId,
        provider_id: external.providerId,
        title,
        cover: candidate.preview?.posterUrl || "",
        rate: candidate.preview?.rating || "",
        episode_info: candidate.preview?.episodeInfo || "",
        url: candidate.preview?.url || external.canonicalUrl || "",
        release_date: candidate.releaseDate || "",
        type: candidate.type,
      }];
    });
    return NextResponse.json({
      code: 200,
      message: "获取成功",
      data: { items, profile: profileId, next_cursor: page.nextCursor, has_more: page.hasMore === true },
    });
  } catch (error) {
    console.error("内容搜索失败:", error);
    return NextResponse.json(
      { code: 502, message: error instanceof Error ? error.message : "内容搜索失败", data: null },
      { status: 502 }
    );
  }
}
