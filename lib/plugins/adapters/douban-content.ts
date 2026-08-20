import {
  getCalendar,
  getHeroMovies,
  getMoviesCategories,
  getNewContentPage,
  getSubjectDetail,
  getCategoryData,
  getTop250,
  getTVCategories,
  searchDouban,
  type CalendarEntry,
  type HeroMovie as ServiceHeroMovie,
  type Subject,
  type SubjectDetail,
} from "@/lib/douban-service";
import type {
  ContentCandidate,
  ContentCalendarCandidate,
  ContentCatalogCandidate,
  ContentDetailCandidate,
  ContentType,
  ImageCandidate,
  Plugin,
  PluginManifest,
  RecommendationCandidate,
} from "@/lib/plugins/types";

export const DOUBAN_CONTENT_PLUGIN_ID = "kerkerker.douban-content";

function serviceHost(): string {
  const configured = process.env.NEXT_PUBLIC_DOUBAN_API_URL || "https://iamyourfather.link0.me";
  try {
    return new URL(configured).hostname;
  } catch {
    return "iamyourfather.link0.me";
  }
}

function provenance(sourceUrl?: string) {
  return {
    source: {
      providerId: DOUBAN_CONTENT_PLUGIN_ID,
      sourceId: "kerkerker-douban-service",
      sourceUrl,
    },
    pluginVersion: doubanContentManifest.version,
    fetchedAt: new Date().toISOString(),
  };
}

function contentType(value?: string): ContentType {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("tv") || normalized.includes("剧") || normalized.includes("series")) {
    return "series";
  }
  return "movie";
}

function subjectCandidate(subject: Subject): ContentCandidate {
  return {
    type: contentType(subject.episode_info),
    externalRefs: [{ providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: subject.id, canonicalUrl: subject.url }],
    titles: [{ locale: "zh-CN", value: subject.title }],
    preview: {
      posterUrl: subject.cover || undefined,
      rating: subject.rate || undefined,
      url: subject.url || undefined,
      episodeInfo: subject.episode_info || undefined,
    },
    provenance: provenance(subject.url),
  };
}

function heroCandidate(hero: ServiceHeroMovie): ContentCatalogCandidate {
  return {
    type: contentType(hero.episode_info),
    externalRefs: [{ providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: hero.id, canonicalUrl: hero.url }],
    titles: [{ locale: "zh-CN", value: hero.title }],
    preview: {
      posterUrl: hero.poster_vertical || hero.cover || undefined,
      backdropUrl: hero.poster_horizontal || undefined,
      rating: hero.rate || undefined,
      url: hero.url || undefined,
      episodeInfo: hero.episode_info || undefined,
      genres: hero.genres || undefined,
    },
    overview: hero.description
      ? [{ locale: "zh-CN", value: hero.description }]
      : undefined,
    provenance: provenance(hero.url),
  };
}

function sectionCandidate(
  subject: Subject,
  sectionName: string,
  sectionIndex: number
): ContentCatalogCandidate {
  return {
    ...subjectCandidate(subject),
    catalog: {
      section: {
        key: sectionName.trim() || `section-${sectionIndex + 1}`,
        titles: [{ locale: "zh-CN", value: sectionName }],
      },
    },
  };
}

function detailCandidate(detail: SubjectDetail): ContentDetailCandidate {
  return {
    type: detail.episodes_count ? "series" : "movie",
    externalRefs: [
      { providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: detail.id, canonicalUrl: detail.url },
      ...(typeof detail.internal_id === "number" && Number.isSafeInteger(detail.internal_id)
        ? [{ providerId: "kerkerker.douban-service", externalId: String(detail.internal_id) }]
        : []),
    ],
    titles: [{ locale: "zh-CN", value: detail.title }],
    overview: detail.description ? [{ locale: "zh-CN", value: detail.description }] : undefined,
    releaseDate: detail.release_year || undefined,
    region: detail.region || undefined,
    details: {
      rating: detail.rate || undefined,
      genres: detail.types || undefined,
      directors: detail.directors || undefined,
      actors: detail.actors || undefined,
      duration: detail.duration || undefined,
      episodeCount: detail.episodes_count || undefined,
      shortComment: detail.short_comment
        ? {
            id: "short-comment",
            content: detail.short_comment.content,
            author: detail.short_comment.author?.name || "",
          }
        : undefined,
      photos: (detail.photos || []).map((photo) => ({
        id: photo.id,
        url: photo.image,
        thumbUrl: photo.thumb || undefined,
      })),
      comments: (detail.comments || []).map((comment) => ({
        id: comment.id,
        content: comment.content,
        author: comment.author?.name || "",
      })),
      recommendations: (detail.recommendations || []).map((subject) => ({
        externalRefs: [{
          providerId: DOUBAN_CONTENT_PLUGIN_ID,
          externalId: subject.id,
          canonicalUrl: subject.url,
        }],
        titles: [{ locale: "zh-CN", value: subject.title }],
        posterUrl: subject.cover || undefined,
        rating: subject.rate || undefined,
      })),
    },
    provenance: provenance(detail.url),
  };
}

function pageFromCursor(cursor: string | undefined): number {
  const page = Number(cursor || 1);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function calendarCandidate(entry: CalendarEntry): ContentCalendarCandidate {
  // show_id belongs to the calendar service and is not guaranteed to be a
  // Douban subject ID. Do not silently put it in the Douban identity namespace.
  const externalId = entry.douban_id?.trim();
  return {
    type: "series",
    externalRefs: externalId
      ? [{ providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId }]
      : [],
    titles: [{ locale: "zh-CN", value: entry.show_name_cn || entry.show_name }],
    overview: entry.overview ? [{ locale: "zh-CN", value: entry.overview }] : undefined,
    releaseDate: entry.air_date || undefined,
    calendar: {
      eventId: [
        String(entry.show_id),
        entry.air_date,
        String(entry.season_number),
        String(entry.episode_number),
      ].join(":"),
      airDate: entry.air_date,
      seasonNumber: entry.season_number,
      episodeNumber: entry.episode_number,
      episodeName: entry.episode_name || undefined,
      posterUrl: entry.poster || undefined,
      backdropUrl: entry.backdrop || undefined,
      rating: Number.isFinite(entry.vote_average) ? entry.vote_average : undefined,
    },
    provenance: provenance(),
  };
}

export const doubanContentManifest: PluginManifest = {
  id: DOUBAN_CONTENT_PLUGIN_ID,
  name: "Kerkerker Douban Content",
  version: "1.0.0",
  contractVersion: "1.0.0",
  runtime: { mode: "built-in", entry: "@/lib/plugins/adapters/douban-content" },
  capabilities: [
    { id: "content.catalog", version: "1.0.0" },
    { id: "content.calendar", version: "1.0.0" },
    { id: "content.detail", version: "1.0.0" },
    { id: "content.search", version: "1.0.0" },
    { id: "asset.image", version: "1.0.0" },
    { id: "recommendation", version: "1.0.0" },
  ],
  locales: ["zh-CN"],
  config: {
    version: "1.0",
    fields: [
      { key: "baseUrl", type: "url", required: true },
      { key: "serviceToken", type: "secret", secret: true },
    ],
  },
  compliance: {
    legalBasis: "operator-review-required",
    contentScope: "movie-and-series-metadata",
    regions: ["GLOBAL"],
    dataClassification: "restricted",
  },
  permissions: {
    networkHosts: [serviceHost()],
    secrets: ["serviceToken"],
    storage: "none",
  },
};

export const doubanContentPlugin: Plugin = {
  manifest: doubanContentManifest,
  capabilities: {
    "content.catalog": {
      async catalog(context, request) {
        if (context.signal.aborted) return { items: [], hasMore: false };
        const view = request.view || "category";
        const page = pageFromCursor(request.cursor);
        const requestOptions = {
          signal: context.signal,
          baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
        };
        if (view === "featured") {
          const response = await getHeroMovies(requestOptions);
          return {
            items: response.map(heroCandidate),
            total: response.length,
            hasMore: false,
          };
        }
        if (view === "new-releases") {
          const response = await getNewContentPage({}, requestOptions);
          const items = response.data.flatMap((section, sectionIndex) =>
            section.data.map((subject) => sectionCandidate(subject, section.name, sectionIndex))
          );
          return { items, total: items.length, hasMore: false };
        }
        if (view === "sections") {
          const sections = request.key === "movies"
            ? await getMoviesCategories(requestOptions)
            : request.key === "series"
              ? await getTVCategories(requestOptions)
              : null;
          if (!sections) {
            throw new Error("目录分区只支持 movies 或 series");
          }
          const items = sections.flatMap((section, sectionIndex) =>
            section.data.map((subject) => sectionCandidate(subject, section.name, sectionIndex))
          );
          return { items, total: items.length, hasMore: false };
        }
        if (view === "latest") {
          const sortMap = {
            recommended: "recommend",
            "release-date": "time",
            rating: "rank",
          } as const;
          const response = await getNewContentPage(
            {
              type: request.filters?.contentType === "series"
                ? "tv"
                : request.filters?.contentType,
              genre: request.filters?.genre,
              year: request.filters?.year,
              region: request.filters?.region,
              sort: request.filters?.sort ? sortMap[request.filters.sort] : undefined,
              page,
              pageSize: request.limit || 30,
            },
            requestOptions
          );
          const items = response.data.flatMap((section, sectionIndex) =>
            section.data.map((subject) => sectionCandidate(subject, section.name, sectionIndex))
          );
          return {
            items,
            total: response.pagination?.total ?? items.length,
            nextCursor: response.pagination?.hasMore ? String(page + 1) : undefined,
            hasMore: response.pagination?.hasMore ?? false,
          };
        }
        const key = request.key || request.category || "hot_movies";
        if (key === "top250") {
          const response = await getTop250(requestOptions);
          const items = response.subjects.map(subjectCandidate);
          return { items, total: items.length, hasMore: false };
        }
        const response = await getCategoryData(key, page, request.limit || 20, {
          ...requestOptions,
        });
        return {
          items: response.subjects.map(subjectCandidate),
          nextCursor: response.pagination.hasMore ? String(page + 1) : undefined,
          hasMore: response.pagination.hasMore,
          total: response.pagination.total,
        };
      },
    },
    "content.calendar": {
      async calendar(context, request) {
        if (context.signal.aborted) return { items: [], hasMore: false };
        const response = await getCalendar(
          { start_date: request.from, end_date: request.to, region: request.region },
          {
            signal: context.signal,
            baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
          }
        );
        const entries = response.days.flatMap((day) => day.entries);
        return { items: entries.map(calendarCandidate), hasMore: false };
      },
    },
    "content.detail": {
      async detail(context, request) {
        if (context.signal.aborted) return null;
        const externalId = request.externalRef?.externalId || request.content?.externalRefs[0]?.externalId;
        if (!externalId) return null;
        const detail = await getSubjectDetail(externalId, {
          signal: context.signal,
          baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
        });
        return detail ? detailCandidate(detail) : null;
      },
    },
    "content.search": {
      async search(context, request) {
        if (context.signal.aborted) return { items: [], hasMore: false };
        const page = pageFromCursor(request.cursor);
        const limit = request.limit || 20;
        const result = await searchDouban(
          request.query,
          undefined,
          { start: (page - 1) * limit, limit },
          {
            signal: context.signal,
            baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
          }
        );
        const seen = new Set<string>();
        const items: ContentCandidate[] = [];
        const addSuggestions = () => {
          for (const item of result.suggest || []) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              items.push({
                type: contentType(item.type),
                externalRefs: [{ providerId: DOUBAN_CONTENT_PLUGIN_ID, externalId: item.id, canonicalUrl: item.url }],
                titles: [{ locale: "zh-CN", value: item.title }],
                preview: {
                  posterUrl: item.img || undefined,
                  url: item.url || undefined,
                  episodeInfo: item.episode || undefined,
                },
                releaseDate: item.year,
                provenance: provenance(item.url),
              });
            }
          }
        };
        // Resource-name matching historically uses the provider's suggestion
        // order and only its first candidates. Do not let an advanced-search
        // result silently change which movie a cloud resource binds to.
        if (request.intent === "resource-match") {
          addSuggestions();
          return { items: items.slice(0, limit), hasMore: false };
        }
        for (const subject of result.advanced || []) {
          if (!seen.has(subject.id)) {
            seen.add(subject.id);
            items.push(subjectCandidate(subject));
          }
        }
        addSuggestions();
        return { items: items.slice(0, limit), hasMore: false };
      },
    },
    "asset.image": {
      async image(context, request): Promise<readonly ImageCandidate[]> {
        if (context.signal.aborted) return [];
        const externalId = request.content.externalRefs[0]?.externalId;
        if (!externalId) return [];
        const detail = await getSubjectDetail(externalId, {
          signal: context.signal,
          baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
        });
        if (!detail) return [];
        const images: ImageCandidate[] = [];
        if (detail.cover) {
          images.push({ contentId: request.content.contentId, purpose: "poster", url: detail.cover, provenance: provenance(detail.cover) });
        }
        for (const photo of detail.photos || []) {
          images.push({ contentId: request.content.contentId, purpose: "still", url: photo.image, provenance: provenance(photo.image) });
        }
        return images;
      },
    },
    recommendation: {
      async recommendation(context, request): Promise<readonly RecommendationCandidate[]> {
        if (context.signal.aborted || !request.content) return [];
        const externalId = request.content.externalRefs[0]?.externalId;
        if (!externalId) return [];
        const detail = await getSubjectDetail(externalId, {
          signal: context.signal,
          baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
        });
        return (detail?.recommendations || []).slice(0, request.limit || 20).map((subject, index) => ({
          externalRefs: [{
            providerId: DOUBAN_CONTENT_PLUGIN_ID,
            externalId: subject.id,
            canonicalUrl: subject.url,
          }],
          score: 1 - index / Math.max(1, (request.limit || 20)),
          reason: [{ locale: "zh-CN", value: "来源推荐" }],
          provenance: provenance(subject.url),
        }));
      },
    },
  },
};
