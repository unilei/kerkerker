import { NextRequest, NextResponse } from "next/server";
import {
  createProfileInvocation,
  getActivePluginProfileId,
  invokeProfilePlugin,
  type ContentDetailCandidate,
} from "@/lib/plugins";
import { findContentIdentityByExternalRef } from "@/lib/content-identity-db";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function preferredTitle(
  values: readonly { locale: string; value: string }[],
  locale: string
): string {
  const exact = values.find((item) => item.locale.toLowerCase() === locale.toLowerCase());
  return exact?.value || values[0]?.value || "";
}

function preferredOverview(
  values: readonly { locale: string; value: string }[] | undefined,
  locale: string
): string {
  return values ? preferredTitle(values, locale) : "";
}

/** Public host boundary for profile-selected, read-only content details. */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const externalId = (await params).id?.trim() || "";
  if (!externalId || externalId.length > 200 || /[\u0000-\u001f/]/.test(externalId)) {
    return NextResponse.json(
      { code: 400, message: "内容 ID 格式无效", data: null },
      { status: 400 }
    );
  }

  try {
    const profileId = getActivePluginProfileId();
    const { context, pluginId } = createProfileInvocation({
      profileId,
      capability: "content.detail",
      signal: request.signal,
      timeoutMs: 15_000,
    });
    const detail = await invokeProfilePlugin<ContentDetailCandidate | null>({
      profileId,
      capability: "content.detail",
      operation: "detail",
      context,
      request: {
        externalRef: { providerId: pluginId, externalId },
      },
    });

    if (!detail) {
      return NextResponse.json(
        { code: 404, message: "未找到内容详情", data: null },
        { status: 404 }
      );
    }

    const external = detail.externalRefs[0];
    const sourceInternalId = detail.externalRefs.find(
      (ref) => ref.providerId === "kerkerker.douban-service"
    )?.externalId;
    const title = preferredTitle(detail.titles, context.locale);
    if (!external || !title) {
      return NextResponse.json(
        { code: 502, message: "插件返回的详情缺少稳定身份或标题", data: null },
        { status: 502 }
      );
    }

    // Identity lookup is deliberately read-only here. A public detail request
    // must not create a host identity; persistence paths resolve identities
    // explicitly before writing resources.
    let hostContentId: string | undefined;
    try {
      hostContentId = (
        await findContentIdentityByExternalRef({
          providerId: external.providerId,
          externalId: external.externalId,
        })
      )?.contentId;
    } catch (error) {
      console.warn("读取宿主内容身份失败，继续返回兼容详情:", error);
    }

    const details = detail.details;
    const recommendations = (details.recommendations || []).flatMap((item) => {
      const ref = item.externalRefs[0];
      const recommendationTitle = preferredTitle(item.titles, context.locale);
      if (!ref || !recommendationTitle) return [];
      return [{
        id: ref.externalId,
        provider_id: ref.providerId,
        title: recommendationTitle,
        cover: item.posterUrl || "",
        rate: item.rating || "",
        url: ref.canonicalUrl || "",
      }];
    });

    return NextResponse.json({
      code: 200,
      message: "获取成功",
      data: {
        profile: profileId,
        provider_id: external.providerId,
        id: external.externalId,
        ...(hostContentId ? { content_id: hostContentId } : {}),
        ...(sourceInternalId && Number.isSafeInteger(Number(sourceInternalId))
          ? { internal_id: Number(sourceInternalId) }
          : {}),
        title,
        cover: detail.preview?.posterUrl || "",
        rate: details.rating || detail.preview?.rating || "",
        types: details.genres || [],
        directors: details.directors || [],
        actors: details.actors || [],
        duration: details.duration || "",
        region: detail.region || "",
        release_year: detail.releaseDate || "",
        episodes_count: details.episodeCount || detail.preview?.episodeInfo || "",
        description: preferredOverview(detail.overview, context.locale),
        short_comment: details.shortComment
          ? {
              content: details.shortComment.content,
              author: { name: details.shortComment.author },
            }
          : undefined,
        photos: (details.photos || []).map((photo) => ({
          id: photo.id,
          image: photo.url,
          thumb: photo.thumbUrl || photo.url,
        })),
        comments: (details.comments || []).map((comment) => ({
          id: comment.id,
          content: comment.content,
          author: { name: comment.author },
        })),
        recommendations,
        canonical_url: external.canonicalUrl || detail.preview?.url || "",
      },
    });
  } catch (error) {
    console.error("内容详情失败:", error);
    return NextResponse.json(
      { code: 502, message: error instanceof Error ? error.message : "内容详情失败", data: null },
      { status: 502 }
    );
  }
}
