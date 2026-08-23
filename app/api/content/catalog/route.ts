import { NextRequest, NextResponse } from "next/server";
import {
  createProfileInvocation,
  getRequestPluginProfileId,
  invokeProfilePlugin,
  type ContentCatalogCandidate,
  type PluginPage,
} from "@/lib/plugins";
import type {
  CatalogFilters,
  CatalogItem,
  CatalogResponse,
  CatalogSection,
  CatalogSort,
  CatalogView,
} from "@/types/content-catalog";

const CATALOG_VIEWS = new Set<CatalogView>([
  "category",
  "featured",
  "new-releases",
  "sections",
  "latest",
]);
const CATALOG_SORTS = new Set<CatalogSort>([
  "recommended",
  "release-date",
  "rating",
]);
const SECTION_KEYS = new Set(["movies", "series"]);
const ALLOWED_QUERY_KEYS = new Set([
  "view",
  "key",
  "category",
  "page",
  "limit",
  "contentType",
  "genre",
  "year",
  "region",
  "sort",
]);

function preferredTitle(
  values: readonly { locale: string; value: string }[],
  locale: string
): string {
  const exact = values.find((item) => item.locale.toLowerCase() === locale.toLowerCase());
  return exact?.value || values[0]?.value || "";
}

function positiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value || fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : 0;
}

function toItem(candidate: ContentCatalogCandidate, locale: string): CatalogItem | null {
  const external = candidate.externalRefs[0];
  const title = preferredTitle(candidate.titles, locale);
  if (!external || !title) return null;
  return {
    id: external.externalId,
    title,
    rating: candidate.preview?.rating || "",
    posterUrl: candidate.preview?.posterUrl || "",
    backdropUrl: candidate.preview?.backdropUrl,
    canonicalUrl: candidate.preview?.url || external.canonicalUrl || "",
    episodeInfo: candidate.preview?.episodeInfo,
    description: candidate.overview
      ? preferredTitle(candidate.overview, locale) || undefined
      : undefined,
    genres: candidate.preview?.genres ? [...candidate.preview.genres] : undefined,
  };
}

function toLegacySubject(item: CatalogItem): CatalogResponse["subjects"][number] {
  return {
    id: item.id,
    title: item.title,
    rate: item.rating,
    cover: item.posterUrl,
    url: item.canonicalUrl,
    episode_info: item.episodeInfo,
  };
}

function isCatalogView(value: string): value is CatalogView {
  return CATALOG_VIEWS.has(value as CatalogView);
}

function isCatalogSort(value: string): value is CatalogSort {
  return CATALOG_SORTS.has(value as CatalogSort);
}

function validFilterValue(value: string | undefined): boolean {
  return value === undefined || (value.length <= 32 && !/[\u0000-\u001f\u007f]/.test(value));
}

/** Public host boundary for profile-selected, read-only catalog pages. */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const viewValue = searchParams.get("view")?.trim() || "category";
  const category = searchParams.get("category")?.trim() || undefined;
  const keyValue = searchParams.get("key")?.trim() || undefined;
  const key = viewValue === "category"
    ? keyValue || category || "hot_movies"
    : viewValue === "sections"
      ? keyValue
      : undefined;
  const page = positiveInt(searchParams.get("page"), 1, 10_000);
  const limit = positiveInt(searchParams.get("limit"), 20, 50);
  const contentType = searchParams.get("contentType")?.trim() || undefined;
  const genre = searchParams.get("genre")?.trim() || undefined;
  const year = searchParams.get("year")?.trim() || undefined;
  const region = searchParams.get("region")?.trim() || undefined;
  const sort = searchParams.get("sort")?.trim() || undefined;
  const hasFilterParams = ["contentType", "genre", "year", "region", "sort"].some(
    (name) => searchParams.has(name)
  );
  const hasUnknownParams = [...searchParams.keys()].some(
    (name) => !ALLOWED_QUERY_KEYS.has(name)
  );
  const hasUnexpectedSelection =
    (category !== undefined && viewValue !== "category") ||
    (keyValue !== undefined && viewValue !== "category" && viewValue !== "sections");
  if (
    !isCatalogView(viewValue) ||
    hasUnknownParams ||
    hasUnexpectedSelection ||
    (key !== undefined && !/^[a-z0-9_-]{1,80}$/.test(key)) ||
    (viewValue === "sections" && (!key || !SECTION_KEYS.has(key))) ||
    (hasFilterParams && viewValue !== "latest") ||
    (contentType !== undefined && contentType !== "movie" && contentType !== "series") ||
    (sort !== undefined && !isCatalogSort(sort)) ||
    !validFilterValue(genre) ||
    !validFilterValue(year) ||
    !validFilterValue(region) ||
    !page ||
    !limit
  ) {
    return NextResponse.json(
      { code: 400, message: "目录查询参数无效", data: null },
      { status: 400 }
    );
  }

  const filters: CatalogFilters | undefined = hasFilterParams
    ? {
        contentType: contentType as CatalogFilters["contentType"],
        genre,
        year,
        region,
        sort: sort as CatalogFilters["sort"],
      }
    : undefined;

  try {
    const profileId = getRequestPluginProfileId(request);
    const { context } = createProfileInvocation({
      profileId,
      capability: "content.catalog",
      signal: request.signal,
      timeoutMs: 15_000,
    });
    const result = await invokeProfilePlugin<PluginPage<ContentCatalogCandidate>>({
      profileId,
      capability: "content.catalog",
      operation: "catalog",
      context,
      request: {
        view: viewValue,
        key,
        cursor: String(page),
        limit,
        filters,
      },
    });
    const items: CatalogItem[] = [];
    const sectionsByKey = new Map<string, CatalogSection>();
    for (const candidate of result.items) {
      const item = toItem(candidate, context.locale);
      if (!item) continue;
      items.push(item);

      const candidateSection = candidate.catalog?.section;
      if (!candidateSection) continue;
      const sectionTitle = preferredTitle(candidateSection.titles, context.locale);
      if (!candidateSection.key || !sectionTitle) continue;
      const section = sectionsByKey.get(candidateSection.key);
      if (section) {
        section.items.push(item);
      } else {
        sectionsByKey.set(candidateSection.key, {
          key: candidateSection.key,
          title: sectionTitle,
          items: [item],
        });
      }
    }
    const data: CatalogResponse = {
      view: viewValue,
      key,
      filters,
      items,
      sections: [...sectionsByKey.values()],
      subjects: items.map(toLegacySubject),
      pagination: {
        page,
        limit,
        total: result.total ?? 0,
        hasMore: result.hasMore === true,
      },
    };
    return NextResponse.json({ code: 200, message: "获取成功", data });
  } catch (error) {
    console.error("内容目录失败:", error);
    return NextResponse.json(
      { code: 502, message: error instanceof Error ? error.message : "内容目录失败", data: null },
      { status: 502 }
    );
  }
}
