import { PluginError } from "@/lib/plugins/errors";
import type {
  ContentCandidate,
  ContentCatalogCandidate,
  ContentCalendarCandidate,
  ContentDetailCandidate,
  ContentType,
  ImageCandidate,
  Plugin,
  PluginContext,
  PluginManifest,
  PluginPage,
} from "@/lib/plugins/types";

export const TMDB_CONTENT_PLUGIN_ID = "kerkerker.tmdb-content";

const DEFAULT_TMDB_BASE_URL = "https://api.themoviedb.org/3";
const DEFAULT_TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const TMDB_SITE_BASE_URL = "https://www.themoviedb.org";

type TmdbKind = "movie" | "tv";

interface TmdbPagedResponse<T> {
  readonly page?: number;
  readonly results?: readonly T[];
  readonly total_pages?: number;
  readonly total_results?: number;
}

interface TmdbMediaResult {
  readonly id?: number;
  readonly media_type?: "movie" | "tv" | "person" | string;
  readonly title?: string;
  readonly name?: string;
  readonly original_title?: string;
  readonly original_name?: string;
  readonly overview?: string;
  readonly poster_path?: string | null;
  readonly backdrop_path?: string | null;
  readonly vote_average?: number;
  readonly release_date?: string;
  readonly first_air_date?: string;
  readonly genre_ids?: readonly number[];
}

interface TmdbImage {
  readonly file_path?: string | null;
  readonly width?: number;
  readonly height?: number;
  readonly aspect_ratio?: number;
}

interface TmdbDetail extends TmdbMediaResult {
  readonly genres?: readonly { id?: number; name?: string }[];
  readonly runtime?: number | null;
  readonly episode_run_time?: readonly number[];
  readonly number_of_episodes?: number | null;
  readonly production_countries?: readonly { iso_3166_1?: string }[];
  readonly credits?: {
    readonly cast?: readonly { id?: number; name?: string }[];
    readonly crew?: readonly { id?: number; name?: string; job?: string }[];
  };
  readonly images?: {
    readonly posters?: readonly TmdbImage[];
    readonly backdrops?: readonly TmdbImage[];
    readonly logos?: readonly TmdbImage[];
  };
  readonly recommendations?: TmdbPagedResponse<TmdbMediaResult>;
}

class TmdbNotFoundError extends Error {}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function pageFromCursor(cursor: string | undefined): number {
  const page = Number(cursor || 1);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function boundedLimit(limit: number | undefined): number {
  return Number.isSafeInteger(limit) && (limit as number) > 0
    ? Math.min(limit as number, 50)
    : 20;
}

function asKind(value: unknown, fallback?: TmdbKind): TmdbKind | null {
  if (value === "movie" || value === "tv") return value;
  return fallback || null;
}

function contentType(kind: TmdbKind): ContentType {
  return kind === "tv" ? "series" : "movie";
}

function canonicalUrl(kind: TmdbKind, id: string): string {
  return `${TMDB_SITE_BASE_URL}/${kind}/${encodeURIComponent(id)}`;
}

function titleFor(value: TmdbMediaResult): string {
  return (
    value.title?.trim() ||
    value.name?.trim() ||
    value.original_title?.trim() ||
    value.original_name?.trim() ||
    ""
  );
}

function ratingFor(value: TmdbMediaResult): string | undefined {
  return typeof value.vote_average === "number" && Number.isFinite(value.vote_average)
    ? String(value.vote_average)
    : undefined;
}

function dateFor(value: TmdbMediaResult): string | undefined {
  const date = value.release_date || value.first_air_date;
  return nonEmpty(date) ? date : undefined;
}

function sourceProvenance(sourceUrl?: string) {
  return {
    source: {
      providerId: TMDB_CONTENT_PLUGIN_ID,
      sourceId: "themoviedb",
      ...(sourceUrl ? { sourceUrl } : {}),
    },
    pluginVersion: tmdbContentManifest.version,
    fetchedAt: new Date().toISOString(),
  };
}

function contextString(context: PluginContext, key: string): string | undefined {
  const value = context.config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeBaseUrl(value: string, fallback: string, path: string): string {
  const raw = (value || fallback).trim().replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error("unsafe URL");
    }
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    throw new PluginError("CONFIGURATION_ERROR", "TMDB 运行配置 URL 无效", {
      path,
      cause: error,
    });
  }
}

function tmdbBaseUrl(context: PluginContext): string {
  return safeBaseUrl(
    contextString(context, "baseUrl") || process.env.TMDB_BASE_URL || "",
    DEFAULT_TMDB_BASE_URL,
    "config.baseUrl"
  );
}

function tmdbImageBase(context: PluginContext, size: string): string {
  const configured = safeBaseUrl(
    contextString(context, "imageBase") || process.env.TMDB_IMAGE_BASE || "",
    DEFAULT_TMDB_IMAGE_BASE,
    "config.imageBase"
  );
  if (/\/(?:w\d+|original)$/i.test(configured)) return configured;
  return `${configured}/${size}`;
}

function imageUrl(context: PluginContext, filePath: string | null | undefined, size = "w500"):
  string | undefined {
  if (!nonEmpty(filePath)) return undefined;
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return `${tmdbImageBase(context, size)}/${filePath.replace(/^\/+/, "")}`;
}

function apiKey(context: PluginContext): string {
  const configured = context.secrets.get("apiKey") || process.env.TMDB_API_KEY;
  if (!nonEmpty(configured)) {
    throw new PluginError("CONFIGURATION_ERROR", "TMDB API 密钥未配置", {
      path: "secrets.apiKey",
    });
  }
  return configured.trim();
}

function tmdbUrl(
  context: PluginContext,
  path: string,
  params: Readonly<Record<string, string | number | boolean | undefined>> = {}
): string {
  const url = new URL(`${tmdbBaseUrl(context)}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("language", context.locale);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchTmdb<T>(
  context: PluginContext,
  path: string,
  params: Readonly<Record<string, string | number | boolean | undefined>> = {}
): Promise<T> {
  if (context.signal.aborted) {
    throw new PluginError("EXECUTION_CANCELLED", "TMDB 调用已取消");
  }

  let response: Response;
  try {
    response = await fetch(tmdbUrl(context, path, params), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey(context)}`,
      },
      signal: context.signal,
    });
  } catch (error) {
    if (context.signal.aborted) {
      throw new PluginError("EXECUTION_CANCELLED", "TMDB 调用已取消", { cause: error });
    }
    throw new PluginError("UPSTREAM_ERROR", "TMDB 请求失败", { cause: error });
  }

  if (response.status === 404) throw new TmdbNotFoundError("TMDB resource not found");
  if (!response.ok) {
    throw new PluginError("UPSTREAM_ERROR", `TMDB 请求失败（HTTP ${response.status}）`, {
      path,
    });
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new PluginError("UPSTREAM_ERROR", "TMDB 返回了无效 JSON", { path, cause: error });
  }
}

function candidateFromResult(
  context: PluginContext,
  result: TmdbMediaResult,
  fallbackKind?: TmdbKind
): ContentCandidate | null {
  if (typeof result.id !== "number" || !Number.isSafeInteger(result.id)) return null;
  const kind = asKind(result.media_type, fallbackKind);
  const title = titleFor(result);
  if (!kind || !title) return null;
  const id = String(result.id);
  const url = canonicalUrl(kind, id);
  return {
    type: contentType(kind),
    externalRefs: [{ providerId: TMDB_CONTENT_PLUGIN_ID, externalId: id, canonicalUrl: url }],
    titles: [{ locale: context.locale, value: title }],
    preview: {
      posterUrl: imageUrl(context, result.poster_path),
      backdropUrl: imageUrl(context, result.backdrop_path, "w1280"),
      rating: ratingFor(result),
      url,
    },
    overview: nonEmpty(result.overview)
      ? [{ locale: context.locale, value: result.overview.trim() }]
      : undefined,
    releaseDate: dateFor(result),
    provenance: sourceProvenance(url),
  };
}

function catalogEndpoint(
  request: Parameters<NonNullable<Plugin["capabilities"]["content.catalog"]>["catalog"]>[1]
): { path: string; kind?: TmdbKind; params: Record<string, string | number | boolean | undefined> } {
  const requestedKind = request.filters?.contentType === "series"
    ? "tv"
    : request.filters?.contentType === "movie"
      ? "movie"
      : request.key === "series"
        ? "tv"
        : request.key === "movies"
          ? "movie"
          : undefined;
  const view = request.view || "category";
  const page = pageFromCursor(request.cursor);
  const params: Record<string, string | number | boolean | undefined> = {
    page,
    include_adult: false,
  };

  if (view === "latest" || view === "new-releases") {
    const kind = requestedKind || "movie";
    const dateSort = kind === "tv" ? "first_air_date.desc" : "primary_release_date.desc";
    const sort = request.filters?.sort === "rating"
      ? "vote_average.desc"
      : request.filters?.sort === "recommended"
        ? "popularity.desc"
        : dateSort;
    if (request.filters?.year) {
      params[kind === "tv" ? "first_air_date_year" : "primary_release_year"] = request.filters.year;
    }
    if (request.filters?.region && /^[A-Z]{2}$/.test(request.filters.region)) {
      params.region = request.filters.region;
    }
    if (request.filters?.genre && /^\d+$/.test(request.filters.genre)) {
      params.with_genres = request.filters.genre;
    }
    params.sort_by = sort;
    return { path: `/discover/${kind}`, kind, params };
  }

  if (!requestedKind) {
    return {
      path: `/trending/all/${view === "featured" ? "week" : "day"}`,
      params,
    };
  }

  return { path: `/${requestedKind}/popular`, kind: requestedKind, params };
}

function detailExternalId(request: Parameters<NonNullable<Plugin["capabilities"]["content.detail"]>["detail"]>[1]): string | undefined {
  const refs = [
    ...(request.externalRef ? [request.externalRef] : []),
    ...(request.content?.externalRefs || []),
  ];
  const ref = refs.find((candidate) => candidate.providerId === TMDB_CONTENT_PLUGIN_ID);
  if (!ref || !/^\d+$/.test(ref.externalId.trim())) return undefined;
  return ref.externalId.trim();
}

async function lookupDetail(
  context: PluginContext,
  externalId: string
): Promise<{ kind: TmdbKind; detail: TmdbDetail } | null> {
  for (const kind of ["movie", "tv"] as const) {
    try {
      const detail = await fetchTmdb<TmdbDetail>(
        context,
        `/${kind}/${encodeURIComponent(externalId)}`,
        { append_to_response: "credits,images,recommendations" }
      );
      return { kind, detail };
    } catch (error) {
      if (error instanceof TmdbNotFoundError) continue;
      throw error;
    }
  }
  return null;
}

function detailCandidate(
  context: PluginContext,
  kind: TmdbKind,
  detail: TmdbDetail
): ContentDetailCandidate | null {
  if (typeof detail.id !== "number" || !Number.isSafeInteger(detail.id)) return null;
  const title = titleFor(detail);
  if (!title) return null;
  const id = String(detail.id);
  const url = canonicalUrl(kind, id);
  const posters = detail.images?.posters || [];
  const backdrops = detail.images?.backdrops || [];
  const photos = [...posters.slice(0, 8), ...backdrops.slice(0, 8)].flatMap((image, index) => {
    const photoUrl = imageUrl(context, image.file_path);
    if (!photoUrl) return [];
    return [{
      id: image.file_path || `tmdb-photo-${index + 1}`,
      url: photoUrl,
      thumbUrl: imageUrl(context, image.file_path, "w185"),
    }];
  });
  const recommendations = (detail.recommendations?.results || []).flatMap((result) => {
    const candidate = candidateFromResult(context, result, kind);
    if (!candidate) return [];
    const ref = candidate.externalRefs[0];
    const titleValue = candidate.titles[0];
    if (!ref || !titleValue) return [];
    return [{
      externalRefs: [ref],
      titles: [titleValue],
      posterUrl: candidate.preview?.posterUrl,
      rating: candidate.preview?.rating,
    }];
  });
  const runtime = kind === "movie"
    ? detail.runtime
    : detail.episode_run_time?.[0];
  const duration = typeof runtime === "number" && runtime > 0
    ? `${runtime} 分钟${kind === "tv" ? "/集" : ""}`
    : undefined;
  const episodeCount = kind === "tv" && typeof detail.number_of_episodes === "number"
    ? String(detail.number_of_episodes)
    : undefined;
  const genres = (detail.genres || []).flatMap((genre) =>
    nonEmpty(genre.name) ? [genre.name.trim()] : []
  );
  const directors = (detail.credits?.crew || []).flatMap((person) =>
    person.job === "Director" && nonEmpty(person.name) ? [person.name.trim()] : []
  );
  const actors = (detail.credits?.cast || []).slice(0, 12).flatMap((person) =>
    nonEmpty(person.name) ? [person.name.trim()] : []
  );
  return {
    type: contentType(kind),
    externalRefs: [{ providerId: TMDB_CONTENT_PLUGIN_ID, externalId: id, canonicalUrl: url }],
    titles: [{ locale: context.locale, value: title }],
    preview: {
      posterUrl: imageUrl(context, detail.poster_path),
      backdropUrl: imageUrl(context, detail.backdrop_path, "w1280"),
      rating: ratingFor(detail),
      url,
    },
    overview: nonEmpty(detail.overview)
      ? [{ locale: context.locale, value: detail.overview.trim() }]
      : undefined,
    releaseDate: dateFor(detail),
    region: detail.production_countries?.find((country) => nonEmpty(country.iso_3166_1))?.iso_3166_1,
    details: {
      rating: ratingFor(detail),
      genres,
      directors,
      actors,
      duration,
      episodeCount,
      photos,
      recommendations,
    },
    provenance: sourceProvenance(url),
  };
}

function imagesForPurpose(
  context: PluginContext,
  contentId: string,
  purpose: string,
  detail: TmdbDetail,
  sourceUrl: string
): readonly ImageCandidate[] {
  const rows: Array<{ image: TmdbImage | null | undefined; size: string; purpose: string }> = [];
  if (purpose === "poster" && detail.poster_path) {
    rows.push({ image: { file_path: detail.poster_path }, size: "w500", purpose: "poster" });
  }
  if (purpose === "backdrop" && detail.backdrop_path) {
    rows.push({ image: { file_path: detail.backdrop_path }, size: "w1280", purpose: "backdrop" });
  }
  const imageRows = purpose === "poster"
    ? detail.images?.posters || []
    : purpose === "logo"
      ? detail.images?.logos || []
      : detail.images?.backdrops || [];
  for (const image of imageRows.slice(0, 20)) {
    rows.push({ image, size: purpose === "poster" ? "w500" : "w1280", purpose });
  }
  return rows.flatMap(({ image, size, purpose: imagePurpose }, index) => {
    const url = imageUrl(context, image?.file_path, size);
    if (!url) return [];
    return [{
      contentId,
      purpose: imagePurpose,
      url,
      ...(typeof image?.width === "number" ? { width: image.width } : {}),
      ...(typeof image?.height === "number" ? { height: image.height } : {}),
      provenance: sourceProvenance(`${sourceUrl}#image-${index + 1}`),
    }];
  });
}

export const tmdbContentManifest: PluginManifest = {
  id: TMDB_CONTENT_PLUGIN_ID,
  name: "Kerkerker TMDB Content",
  version: "1.0.0",
  contractVersion: "1.0.0",
  runtime: { mode: "built-in", entry: "@/lib/plugins/adapters/tmdb-content" },
  capabilities: [
    { id: "content.catalog", version: "1.0.0" },
    { id: "content.calendar", version: "1.0.0" },
    { id: "content.detail", version: "1.0.0" },
    { id: "content.search", version: "1.0.0" },
    { id: "asset.image", version: "1.0.0" },
  ],
  locales: ["en-US"],
  config: {
    version: "1.0",
    fields: [
      { key: "baseUrl", type: "url", required: true },
      { key: "imageBase", type: "url", required: true },
      { key: "apiKey", type: "secret", required: true, secret: true },
    ],
  },
  compliance: {
    legalBasis: "operator-approved-tmdb-api-terms",
    termsUrl: "https://www.themoviedb.org/terms-of-use",
    contentScope: ["movie-and-series-metadata", "poster-and-backdrop-image-references"],
    regions: ["GLOBAL"],
    dataClassification: "licensed",
  },
  permissions: {
    networkHosts: ["api.themoviedb.org", "image.tmdb.org"],
    secrets: ["apiKey"],
    storage: "none",
  },
};

export const tmdbContentPlugin: Plugin = {
  manifest: tmdbContentManifest,
  capabilities: {
    "content.catalog": {
      async catalog(context, request): Promise<PluginPage<ContentCatalogCandidate>> {
        if (context.signal.aborted) return { items: [], hasMore: false };
        const endpoint = catalogEndpoint(request);
        const response = await fetchTmdb<TmdbPagedResponse<TmdbMediaResult>>(
          context,
          endpoint.path,
          endpoint.params
        );
        const items = (response.results || [])
          .map((result) => candidateFromResult(context, result, endpoint.kind))
          .filter((candidate): candidate is ContentCatalogCandidate => candidate !== null)
          .slice(0, boundedLimit(request.limit))
          .map((candidate) => ({ ...candidate }));
        const page = pageFromCursor(request.cursor);
        const totalPages = typeof response.total_pages === "number" ? response.total_pages : page;
        return {
          items,
          total: typeof response.total_results === "number" ? response.total_results : items.length,
          nextCursor: page < totalPages ? String(page + 1) : undefined,
          hasMore: page < totalPages,
        };
      },
    },
    "content.calendar": {
      async calendar(context, request): Promise<PluginPage<ContentCalendarCandidate>> {
        if (context.signal.aborted) return { items: [], hasMore: false };
        const response = await fetchTmdb<TmdbPagedResponse<TmdbMediaResult>>(
          context,
          "/discover/tv",
          {
            "air_date.gte": request.from,
            "air_date.lte": request.to,
            with_origin_country: request.region,
            sort_by: "first_air_date.asc",
            page: pageFromCursor(request.cursor),
            include_adult: false,
          }
        );
        const items = (response.results || []).flatMap((result) => {
          if (typeof result.id !== "number" || !Number.isSafeInteger(result.id)) return [];
          const title = titleFor(result);
          const airDate = dateFor(result);
          if (!title || !airDate) return [];
          const id = String(result.id);
          const url = canonicalUrl("tv", id);
          return [{
            type: "series" as const,
            externalRefs: [{ providerId: TMDB_CONTENT_PLUGIN_ID, externalId: id, canonicalUrl: url }],
            titles: [{ locale: context.locale, value: title }],
            preview: {
              posterUrl: imageUrl(context, result.poster_path),
              backdropUrl: imageUrl(context, result.backdrop_path, "w1280"),
              rating: ratingFor(result),
              url,
            },
            releaseDate: airDate,
            calendar: {
              // TMDB discovery does not expose episode-level schedule data.
              // Keep a stable show/date key and deterministic defaults until a
              // schedule-aware provider is introduced.
              eventId: `${id}:${airDate}:1:1`,
              airDate,
              seasonNumber: 1,
              episodeNumber: 1,
              posterUrl: imageUrl(context, result.poster_path),
              backdropUrl: imageUrl(context, result.backdrop_path, "w1280"),
              rating: typeof result.vote_average === "number" && Number.isFinite(result.vote_average)
                ? result.vote_average
                : undefined,
            },
            provenance: sourceProvenance(url),
          } satisfies ContentCalendarCandidate];
        }).slice(0, boundedLimit(request.limit));
        const page = pageFromCursor(request.cursor);
        const totalPages = typeof response.total_pages === "number" ? response.total_pages : page;
        return {
          items,
          total: typeof response.total_results === "number" ? response.total_results : items.length,
          nextCursor: page < totalPages ? String(page + 1) : undefined,
          hasMore: page < totalPages,
        };
      },
    },
    "content.detail": {
      async detail(context, request): Promise<ContentDetailCandidate | null> {
        const externalId = detailExternalId(request);
        if (!externalId || context.signal.aborted) return null;
        const result = await lookupDetail(context, externalId);
        return result ? detailCandidate(context, result.kind, result.detail) : null;
      },
    },
    "content.search": {
      async search(context, request): Promise<PluginPage<ContentCandidate>> {
        if (context.signal.aborted) return { items: [], hasMore: false };
        const page = pageFromCursor(request.cursor);
        const limit = boundedLimit(request.limit);
        const response = await fetchTmdb<TmdbPagedResponse<TmdbMediaResult>>(
          context,
          "/search/multi",
          {
            query: request.query.trim(),
            page,
            include_adult: false,
          }
        );
        const items = (response.results || [])
          .map((result) => candidateFromResult(context, result))
          .filter((candidate): candidate is ContentCandidate => candidate !== null)
          .slice(0, limit);
        const totalPages = typeof response.total_pages === "number" ? response.total_pages : page;
        return {
          items,
          total: typeof response.total_results === "number" ? response.total_results : items.length,
          nextCursor: page < totalPages ? String(page + 1) : undefined,
          hasMore: page < totalPages,
        };
      },
    },
    "asset.image": {
      async image(context, request): Promise<readonly ImageCandidate[]> {
        if (context.signal.aborted || !request.content.contentId) return [];
        const externalId = request.content.externalRefs.find(
          (ref) => ref.providerId === TMDB_CONTENT_PLUGIN_ID
        )?.externalId;
        if (!externalId || !/^\d+$/.test(externalId.trim())) return [];
        const result = await lookupDetail(context, externalId.trim());
        if (!result) return [];
        const url = canonicalUrl(result.kind, externalId.trim());
        return imagesForPurpose(context, request.content.contentId, request.purpose, result.detail, url);
      },
    },
  },
};
