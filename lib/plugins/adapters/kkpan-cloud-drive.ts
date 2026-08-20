import {
  cleanKkpanTitle,
  listKkpanPageWithMeta,
  searchKkpanResourcesWithMeta,
  type KkpanResource,
} from "@/lib/kkpan";
import type {
  CloudDriveResourceCandidate,
  Plugin,
  PluginManifest,
} from "@/lib/plugins/types";

export const KKPAN_PLUGIN_ID = "kerkerker.kkpan-cloud-drive";

function serviceHost(): string {
  const configured = process.env.KKPAN_API_BASE || "https://www.kkpans.com";
  try {
    return new URL(configured).hostname;
  } catch {
    return "www.kkpans.com";
  }
}

function provenance(url?: string) {
  return {
    source: { providerId: KKPAN_PLUGIN_ID, sourceId: "kkpans-public-catalog", sourceUrl: url },
    pluginVersion: kkpanCloudDriveManifest.version,
    fetchedAt: new Date().toISOString(),
  };
}

function pageFromCursor(cursor: string | undefined): number {
  const page = Number(cursor || 1);
  return Number.isSafeInteger(page) && page > 0 && page <= 100_000 ? page : 1;
}

function pageSizeFromLimit(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(Number.isSafeInteger(limit) ? limit! : fallback, 1), 50);
}

function candidate(item: KkpanResource, contentId?: string, availability: CloudDriveResourceCandidate["availability"] = "available"): CloudDriveResourceCandidate {
  return {
    kind: "cloud-drive",
    contentId,
    providerId: KKPAN_PLUGIN_ID,
    externalId: String(item.id),
    title: cleanKkpanTitle(item.fileName),
    platform: {
      platformId: item.targetPlatform,
      brand: item.targetPlatform,
      displayName: item.targetPlatform === "other" ? "其他网盘" : item.targetPlatform,
    },
    url: item.shareLink,
    accessCode: item.shareCode || undefined,
    format: /\b(MP4|MKV|AVI|MOV|RMVB|WMV|FLV|WEBM|ISO|TS)\b/i.exec(item.fileName)?.[1]?.toUpperCase(),
    sizeBytes: item.fileSize || undefined,
    sourceUpdatedAt: item.updatedAt,
    availability,
    provenance: provenance(item.shareLink),
  };
}

export const kkpanCloudDriveManifest: PluginManifest = {
  id: KKPAN_PLUGIN_ID,
  name: "Kerkerker KKPAN Cloud Drive",
  version: "1.0.0",
  contractVersion: "1.0.0",
  runtime: { mode: "built-in", entry: "@/lib/plugins/adapters/kkpan-cloud-drive" },
  capabilities: [
    {
      id: "resource.cloud-drive",
      version: "1.0.0",
      features: ["search", "incremental", "availability"],
    },
  ],
  locales: ["zh-CN"],
  config: {
    version: "1.0",
    fields: [{ key: "baseUrl", type: "url", required: true }],
  },
  compliance: {
    legalBasis: "operator-review-required",
    contentScope: "operator-approved-cloud-drive-resource-catalog",
    regions: ["GLOBAL"],
    dataClassification: "restricted",
  },
  permissions: {
    networkHosts: [serviceHost()],
    secrets: [],
    storage: "namespaced",
  },
};

export const kkpanCloudDrivePlugin: Plugin = {
  manifest: kkpanCloudDriveManifest,
  capabilities: {
    "resource.cloud-drive": {
      async search(context, request) {
        if (context.signal.aborted) return { items: [], hasMore: false };
        const limit = pageSizeFromLimit(request.limit, 40);
        const page = pageFromCursor(request.cursor);
        const result = await searchKkpanResourcesWithMeta(request.title, limit, page, {
          baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
          signal: context.signal,
        });
        const hasMore = result.total !== undefined ? page * limit < result.total : result.rawCount >= limit;
        return {
          items: result.items.map((item) => candidate(item, request.content?.contentId)),
          hasMore,
          nextCursor: hasMore ? String(page + 1) : undefined,
        };
      },
      async incremental(context, request) {
        if (context.signal.aborted) return { items: [], hasMore: false };
        const page = pageFromCursor(request.cursor);
        const limit = pageSizeFromLimit(request.limit, 50);
        const result = await listKkpanPageWithMeta(page, limit, {
          baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
          signal: context.signal,
        });
        const items = request.updatedSince
          ? result.items.filter((item) => item.updatedAt > request.updatedSince!)
          : result.items;
        const hasMore = result.total !== undefined ? page * limit < result.total : result.rawCount >= limit;
        return {
          items: items.map((item) => candidate(item)),
          hasMore,
          nextCursor: hasMore ? String(page + 1) : undefined,
        };
      },
      async availability(context, request) {
        const checked: CloudDriveResourceCandidate[] = [];
        for (const resource of request.resources) {
          if (context.signal.aborted) break;
          if (!resource.title.trim()) {
            checked.push({ ...resource, availability: "unknown", provenance: provenance(resource.url) });
            continue;
          }
          try {
            const pageSize = 50;
            const maxPages = 200;
            let page = 1;
            let complete = false;
            let live: KkpanResource | undefined;
            const seenIds = new Set<string>();
            while (page <= maxPages) {
              if (context.signal.aborted) break;
              const result = await searchKkpanResourcesWithMeta(resource.title, pageSize, page, {
                baseUrl: typeof context.config.baseUrl === "string" ? context.config.baseUrl : undefined,
                signal: context.signal,
              });
              if (result.rawIds.some((id) => {
                const key = String(id);
                if (seenIds.has(key)) return true;
                seenIds.add(key);
                return false;
              })) {
                break;
              }
              live = result.items.find((item) => String(item.id) === resource.externalId);
              if (live) break;
              const hasMore = result.total !== undefined
                ? page * pageSize < result.total
                : result.rawCount >= pageSize;
              if (!hasMore) {
                complete = true;
                break;
              }
              page += 1;
            }
            if (live) {
              checked.push(candidate(live, resource.contentId, "available"));
            } else if (complete) {
              checked.push({ ...resource, availability: "unavailable", provenance: provenance(resource.url) });
            } else {
              checked.push({ ...resource, availability: "unknown", provenance: provenance(resource.url) });
            }
          } catch {
            checked.push({ ...resource, availability: "unknown", provenance: provenance(resource.url) });
          }
        }
        return checked;
      },
    },
  },
};
