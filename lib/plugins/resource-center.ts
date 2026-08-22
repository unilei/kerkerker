import {
  getAllPanResources,
} from "@/lib/pan-resources-db";
import { isValidContentId } from "@/lib/content-identity-db";
import { filterPublicPanResources } from "@/lib/pan/resource-audit";
import type { PanResource } from "@/types/pan-resource";

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
    readonly keyword?: string;
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

const defaultReader: ResourceCenterReader = {
  async list(options) {
    return getAllPanResources({
      contentId: options.contentId,
      keyword: options.keyword,
      // Filtering by provider/platform happens below because the compatibility
      // repository predates the generic resource-center query shape.
      limit: options.limit,
    });
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
    // Fetch the bounded API window before applying provider/platform filters.
    // The limit is deliberately capped to avoid an unbounded compatibility
    // scan; the generic store will provide indexed filtering in the next step.
    limit: Math.min(Math.max(query.limit, RESOURCE_CENTER_DEFAULT_LIMIT), RESOURCE_CENTER_MAX_LIMIT),
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
