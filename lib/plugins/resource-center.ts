import type { Filter } from "mongodb";
import { isValidContentId } from "@/lib/content-identity-db";
import { COLLECTIONS } from "@/lib/constants/db";
import { getDatabase } from "@/lib/db";
import { filterPublicPanResources } from "@/lib/pan/resource-audit";
import type { PanResource, PanBrand } from "@/types/pan-resource";
import type { PanResourceDoc } from "@/lib/pan-resources-db";

/**
 * Provider-neutral read model for the resource center.
 *
 * The current Mongo collection is still the legacy `pan_resources` store.  The
 * adapter deliberately projects only the stable host fields so callers do not
 * start depending on `douban_id`, `kkpan_id`, or `source` again.
 */
export interface ResourceCenterItem {
  readonly id: string;
  readonly content_id?: string;
  readonly provider?: {
    readonly id: string;
    readonly resource_id: string;
  };
  readonly platform: {
    readonly id: string;
    readonly brand: string;
  };
  readonly title: string;
  readonly url: string;
  readonly access_code?: string;
  readonly size?: string;
  readonly format?: string;
  /** Compatibility projection; a future availability check may refine it. */
  readonly availability: "available" | "unavailable";
  readonly enabled: boolean;
  readonly identity_complete: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ResourceCenterQuery {
  readonly contentId?: string;
  readonly providerId?: string;
  readonly providerResourceId?: string;
  readonly platformId?: string;
  readonly keyword?: string;
  readonly enabled?: boolean;
  /** Include legacy rows that have not received a provider identity yet. */
  readonly includeLegacy?: boolean;
  /** Internal route flag; never accepted directly from a client query. */
  readonly publicOnly?: boolean;
  readonly limit: number;
}

export interface ResourceCenterReader {
  list(options: {
    readonly contentId?: string;
    readonly providerId?: string;
    readonly providerResourceId?: string;
    readonly platformId?: string;
    readonly keyword?: string;
    readonly enabled?: boolean;
    readonly includeLegacy?: boolean;
    readonly limit: number;
  }): Promise<readonly PanResource[]>;
  filterPublic?(
    resources: readonly PanResource[],
    contentId?: string
  ): Promise<readonly PanResource[]>;
}

export const RESOURCE_CENTER_DEFAULT_LIMIT = 50;
export const RESOURCE_CENTER_MAX_LIMIT = 200;

const PROVIDER_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const MAX_PROVIDER_RESOURCE_ID_LENGTH = 500;
const MAX_QUERY_TEXT_LENGTH = 200;

export class ResourceCenterQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceCenterQueryError";
  }
}

function optionalText(
  value: string | null,
  name: string,
  maxLength = MAX_QUERY_TEXT_LENGTH
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new ResourceCenterQueryError(`${name} 查询参数格式无效`);
  }
  return normalized;
}

function optionalBoolean(value: string | null, name: string): boolean | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ResourceCenterQueryError(`${name} 必须是 true 或 false`);
}

function parseLimit(value: string | null): number {
  if (value === null || value.trim() === "") {
    return RESOURCE_CENTER_DEFAULT_LIMIT;
  }
  if (!/^\d+$/.test(value)) {
    throw new ResourceCenterQueryError(
      `limit 必须是 1 到 ${RESOURCE_CENTER_MAX_LIMIT} 的整数`
    );
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RESOURCE_CENTER_MAX_LIMIT) {
    throw new ResourceCenterQueryError(
      `limit 必须是 1 到 ${RESOURCE_CENTER_MAX_LIMIT} 的整数`
    );
  }
  return limit;
}

/** Parse and validate the public/admin resource center query once at the edge. */
export function parseResourceCenterQuery(
  params: URLSearchParams
): ResourceCenterQuery {
  const contentId = optionalText(params.get("content_id"), "content_id");
  if (contentId && !isValidContentId(contentId)) {
    throw new ResourceCenterQueryError("content_id 格式无效");
  }

  const providerId = optionalText(params.get("provider_id"), "provider_id");
  if (providerId && !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new ResourceCenterQueryError("provider_id 格式无效");
  }
  const providerResourceId = optionalText(
    params.get("provider_resource_id"),
    "provider_resource_id",
    MAX_PROVIDER_RESOURCE_ID_LENGTH
  );
  if (Boolean(providerId) !== Boolean(providerResourceId)) {
    throw new ResourceCenterQueryError(
      "provider_id 和 provider_resource_id 必须同时提供"
    );
  }

  const platformId = optionalText(params.get("platform_id"), "platform_id");
  const keyword = optionalText(params.get("keyword"), "keyword");
  const enabled = optionalBoolean(params.get("enabled"), "enabled");

  return {
    ...(contentId ? { contentId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerResourceId ? { providerResourceId } : {}),
    ...(platformId ? { platformId } : {}),
    ...(keyword ? { keyword } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(params.get("include_legacy") === "true" ? { includeLegacy: true } : {}),
    limit: parseLimit(params.get("limit")),
  };
}

function hasProviderIdentity(resource: PanResource): resource is PanResource & {
  provider_id: string;
  provider_resource_id: string;
} {
  return Boolean(resource.provider_id && resource.provider_resource_id);
}

/** Convert the compatibility record to the host-owned resource DTO. */
export function toResourceCenterItem(resource: PanResource): ResourceCenterItem {
  const provider = hasProviderIdentity(resource)
    ? {
        id: resource.provider_id,
        resource_id: resource.provider_resource_id,
      }
    : undefined;
  return {
    id: resource.id,
    ...(resource.content_id ? { content_id: resource.content_id } : {}),
    ...(provider ? { provider } : {}),
    platform: {
      id: resource.brand,
      brand: resource.brand,
    },
    title: resource.title,
    url: resource.url,
    ...(resource.code ? { access_code: resource.code } : {}),
    ...(resource.size ? { size: resource.size } : {}),
    ...(resource.format ? { format: resource.format } : {}),
    availability: resource.enabled ? "available" : "unavailable",
    enabled: resource.enabled,
    identity_complete: Boolean(resource.content_id && provider),
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPanResource(doc: PanResourceDoc): PanResource {
  if (!doc._id) throw new Error("资源记录缺少数据库 ID");
  return {
    id: doc._id.toString(),
    douban_id: doc.douban_id,
    ...(doc.content_id ? { content_id: doc.content_id } : {}),
    ...(doc.internal_id !== undefined ? { internal_id: doc.internal_id } : {}),
    ...(doc.movie_title ? { movie_title: doc.movie_title } : {}),
    brand: doc.brand,
    title: doc.title,
    ...(doc.size ? { size: doc.size } : {}),
    ...(doc.format ? { format: doc.format } : {}),
    url: doc.url,
    ...(doc.code ? { code: doc.code } : {}),
    ...(doc.note ? { note: doc.note } : {}),
    ...(doc.source ? { source: doc.source } : {}),
    ...(doc.provider_id ? { provider_id: doc.provider_id } : {}),
    ...(doc.provider_resource_id
      ? { provider_resource_id: doc.provider_resource_id }
      : {}),
    ...(doc.kkpan_id !== undefined ? { kkpan_id: doc.kkpan_id } : {}),
    enabled: doc.enabled,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

const defaultReader: ResourceCenterReader = {
  async list(options) {
    const filter: Filter<PanResourceDoc> = {};
    if (options.contentId) filter.content_id = options.contentId;
    if (options.providerId) filter.provider_id = options.providerId;
    if (options.providerResourceId) {
      filter.provider_resource_id = options.providerResourceId;
    }
    if (options.platformId) filter.brand = options.platformId as PanBrand;
    if (options.enabled !== undefined) filter.enabled = options.enabled;
    if (options.includeLegacy === false) {
      // Both halves are required. `$type` avoids matching malformed partial
      // migrations where only one provider field was copied.
      if (!options.providerId) filter.provider_id = { $type: "string" };
      if (!options.providerResourceId) {
        filter.provider_resource_id = { $type: "string" };
      }
    }
    if (options.keyword) {
      const pattern = escapeRegex(options.keyword);
      filter.$or = [
        { title: { $regex: pattern, $options: "i" } },
        { movie_title: { $regex: pattern, $options: "i" } },
        { douban_id: { $regex: pattern, $options: "i" } },
      ];
    }
    const db = await getDatabase();
    const docs = await db
      .collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES)
      .find(filter)
      .sort({ updated_at: -1, _id: -1 })
      .limit(options.limit)
      .toArray();
    return docs.map(toPanResource);
  },
  async filterPublic(resources, contentId) {
    return filterPublicPanResources(resources, undefined, { contentId });
  },
};

/**
 * Read resources through a provider-neutral query.  This is intentionally a
 * read adapter while the legacy collection is being migrated; writes remain
 * behind the existing audited repository until the generic storage schema is
 * promoted.
 */
export async function listResourceCenterResources(
  query: ResourceCenterQuery,
  reader: ResourceCenterReader = defaultReader
): Promise<ResourceCenterItem[]> {
  const rows = await reader.list({
    ...(query.contentId ? { contentId: query.contentId } : {}),
    ...(query.keyword ? { keyword: query.keyword } : {}),
    ...(query.providerId ? { providerId: query.providerId } : {}),
    ...(query.providerResourceId
      ? { providerResourceId: query.providerResourceId }
      : {}),
    ...(query.platformId ? { platformId: query.platformId } : {}),
    ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
    ...(query.includeLegacy !== undefined
      ? { includeLegacy: query.includeLegacy }
      : { includeLegacy: false }),
    // The default reader pushes filters into Mongo, so the requested limit is
    // sufficient and does not require an oversized compatibility scan.
    limit: query.limit,
  });
  const policyRows = query.publicOnly
    ? await (reader.filterPublic || defaultReader.filterPublic!)(
        rows,
        query.contentId
      )
    : rows;
  const keyword = query.keyword?.toLocaleLowerCase();
  const filtered = policyRows.filter((resource) => {
    if (query.enabled !== undefined && resource.enabled !== query.enabled) return false;
    if (query.providerId && resource.provider_id !== query.providerId) return false;
    if (
      query.providerResourceId &&
      resource.provider_resource_id !== query.providerResourceId
    ) {
      return false;
    }
    if (query.platformId && resource.brand !== query.platformId) return false;
    if (!query.includeLegacy && !hasProviderIdentity(resource)) return false;
    if (keyword) {
      const haystack = [resource.title, resource.movie_title, resource.douban_id]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const updated = b.updated_at.localeCompare(a.updated_at);
    if (updated !== 0) return updated;
    return b.id.localeCompare(a.id);
  });
  return filtered.slice(0, query.limit).map(toResourceCenterItem);
}
