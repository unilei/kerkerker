/**
 * Provider-neutral cloud-drive task boundary.
 *
 * The sync engine historically consumed KKPAN-shaped pages directly.  New
 * jobs should depend on `CloudDriveTaskAdapter` instead; the adapter selects
 * the provider through the active plugin profile and carries optional page
 * consistency evidence needed by offset-based reconciliation jobs.
 */

import {
  incrementCloudDriveResources,
  searchCloudDriveResources,
  type ResourceHostExecutionOptions,
} from "@/lib/plugins/resource-host";
import type {
  CloudDriveIncrementalRequest,
  CloudDriveResourceCandidate,
  CloudDriveSearchRequest,
  PluginPage,
  PluginPageConsistency,
} from "@/lib/plugins/types";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import type { KkpanPageResult, KkpanResource, KkpanPlatform } from "@/lib/kkpan";

export type CloudDriveTaskExecutionOptions = ResourceHostExecutionOptions;

/** A page normalized for reconciliation tasks, independent of any provider. */
export interface CloudDriveTaskPage
  extends PluginPage<CloudDriveResourceCandidate> {
  readonly rawCount: number;
  readonly rawIds: readonly string[];
  readonly fingerprint: string;
}

export interface CloudDriveTaskAdapter {
  search(
    request: CloudDriveSearchRequest,
    options?: CloudDriveTaskExecutionOptions
  ): Promise<CloudDriveTaskPage>;
  incremental(
    request: CloudDriveIncrementalRequest,
    options?: CloudDriveTaskExecutionOptions
  ): Promise<CloudDriveTaskPage>;
}

function validConsistency(value: unknown): value is PluginPageConsistency {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PluginPageConsistency>;
  return (
    Number.isSafeInteger(candidate.rawCount) &&
    (candidate.rawCount as number) >= 0 &&
    Array.isArray(candidate.rawIds) &&
    candidate.rawIds.every((id) => typeof id === "string") &&
    typeof candidate.fingerprint === "string"
  );
}

function fallbackConsistency(
  items: readonly CloudDriveResourceCandidate[]
): PluginPageConsistency {
  const rawIds = items.map((item) => item.externalId);
  return {
    rawCount: rawIds.length,
    rawIds,
    fingerprint: JSON.stringify(
      items.map((item) => [
        item.externalId,
        item.title,
        item.sourceUpdatedAt,
        item.url,
        item.accessCode,
        item.sizeBytes,
        item.platform.platformId,
      ])
    ),
  };
}

function normalizePage(
  page: PluginPage<CloudDriveResourceCandidate>
): CloudDriveTaskPage {
  if (!page || !Array.isArray(page.items)) {
    throw new Error("cloud-drive 插件响应格式无效：items 必须是数组");
  }
  const consistency = validConsistency(page.consistency)
    ? page.consistency
    : fallbackConsistency(page.items);
  if (consistency.rawCount < consistency.rawIds.length) {
    throw new Error("cloud-drive 插件响应格式无效：rawCount 小于 rawIds");
  }
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    total: page.total,
    rawCount: consistency.rawCount,
    rawIds: consistency.rawIds,
    fingerprint: consistency.fingerprint,
    consistency,
  };
}

function mergeOptions(
  base: CloudDriveTaskExecutionOptions,
  override: CloudDriveTaskExecutionOptions | undefined
): CloudDriveTaskExecutionOptions {
  return { ...base, ...(override || {}) };
}

/**
 * Build a provider-neutral task adapter. The returned object has no provider
 * name in its API; the active deployment profile decides which plugin runs.
 */
export function createCloudDriveTaskAdapter(
  baseOptions: CloudDriveTaskExecutionOptions = {}
): CloudDriveTaskAdapter {
  const adapter: CloudDriveTaskAdapter = {
    async search(
      request: CloudDriveSearchRequest,
      options?: CloudDriveTaskExecutionOptions
    ) {
      const page = await searchCloudDriveResources(
        request,
        mergeOptions(baseOptions, options)
      );
      return normalizePage(page);
    },
    async incremental(
      request: CloudDriveIncrementalRequest,
      options?: CloudDriveTaskExecutionOptions
    ) {
      const page = await incrementCloudDriveResources(
        request,
        mergeOptions(baseOptions, options)
      );
      return normalizePage(page);
    },
  };
  return Object.freeze(adapter);
}

/** The default adapter used by server jobs that do not need custom context. */
export const cloudDriveTaskAdapter = createCloudDriveTaskAdapter();

/* ------------------------------------------------------------------------- *
 * Legacy KKPAN bridge
 * ------------------------------------------------------------------------- */

function asSafeKkpanId(externalId: string): number {
  if (!/^[1-9]\d*$/.test(externalId)) {
    throw new Error(
      "当前兼容同步只支持正整数来源 ID；请先迁移该资源到 provider_resource_id"
    );
  }
  const id = Number(externalId);
  if (!Number.isSafeInteger(id) || String(id) !== externalId) {
    throw new Error("KKPAN 来源 ID 超出安全整数范围");
  }
  return id;
}

function asKkpanPlatform(value: string): KkpanPlatform {
  return (["quark", "baidu", "guangya", "xunlei", "uc", "other"] as const).includes(
    value as KkpanPlatform
  )
    ? (value as KkpanPlatform)
    : "other";
}

/**
 * Convert a neutral page back to the old KKPAN page shape during migration.
 * This is intentionally strict: a non-KKPAN plugin must never be written into
 * legacy `kkpan_id` fields by accident.
 */
export function toLegacyKkpanPage(page: CloudDriveTaskPage): KkpanPageResult {
  const items: KkpanResource[] = page.items.map((item) => {
    if (item.providerId !== KKPAN_PLUGIN_ID) {
      throw new Error(
        `插件 ${item.providerId} 的资源不能写入旧 KKPAN 同步字段`
      );
    }
    return {
      id: asSafeKkpanId(item.externalId),
      fileName: item.sourceName || item.title,
      shareLink: item.url,
      shareCode: item.accessCode,
      fileSize: item.sizeBytes,
      targetPlatform: asKkpanPlatform(item.platform.platformId),
      updatedAt: item.sourceUpdatedAt || "",
    };
  });
  return {
    items,
    total: page.total,
    rawCount: page.rawCount,
    rawIds: page.rawIds.map(asSafeKkpanId),
    fingerprint: page.fingerprint,
  };
}

/**
 * Compatibility helpers for the existing sync engine. They preserve its
 * page-number API while routing the actual request through the neutral task
 * adapter. New code should call `CloudDriveTaskAdapter` directly.
 */
export async function searchCloudDriveTaskPage(
  title: string,
  limit = 40,
  page = 1,
  options: CloudDriveTaskExecutionOptions = {}
): Promise<KkpanPageResult> {
  const result = await cloudDriveTaskAdapter.search(
    { title, limit: Math.min(Math.max(Math.floor(limit), 1), 50), cursor: String(Math.max(page, 1)) },
    options
  );
  return toLegacyKkpanPage(result);
}

export async function listCloudDriveTaskPage(
  page = 1,
  limit = 50,
  options: CloudDriveTaskExecutionOptions = {}
): Promise<KkpanPageResult> {
  const result = await cloudDriveTaskAdapter.incremental(
    {
      limit: Math.min(Math.max(Math.floor(limit), 1), 50),
      cursor: String(Math.max(page, 1)),
    },
    options
  );
  return toLegacyKkpanPage(result);
}
