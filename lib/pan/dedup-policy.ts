import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import type { PanResourceDoc } from "@/lib/pan-resources-db";

const PROVIDER_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;

export interface ProviderPair {
  providerId: string;
  providerResourceId: string;
}

export type KkpanIdentityResolution =
  | { kind: "kkpan"; kkpanId: number; pair?: ProviderPair }
  | { kind: "other"; pair?: ProviderPair }
  | { kind: "conflict"; reason: string };

export function isValidKkpanId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

export function validProviderPair(
  providerId: unknown,
  providerResourceId: unknown
): ProviderPair | undefined {
  const id = nonEmptyString(providerId);
  const resourceId = nonEmptyString(providerResourceId);
  if (!id || !resourceId || !PROVIDER_ID_PATTERN.test(id)) return undefined;
  if (resourceId.length > 500 || /[\u0000-\u001f]/.test(resourceId)) return undefined;
  return { providerId: id, providerResourceId: resourceId };
}

function kkpanIdFromProviderPair(pair?: ProviderPair): number | undefined {
  if (pair?.providerId !== KKPAN_PLUGIN_ID || !/^[1-9]\d*$/.test(pair.providerResourceId)) {
    return undefined;
  }
  const value = Number(pair.providerResourceId);
  return isValidKkpanId(value) && String(value) === pair.providerResourceId
    ? value
    : undefined;
}

export function hasMeaningfulProviderValue(doc: PanResourceDoc): boolean {
  return Boolean(nonEmptyString(doc.provider_id) || nonEmptyString(doc.provider_resource_id));
}

/** Resolve the legacy and canonical KKPAN fields as one stable identity. */
export function resolveKkpanIdentity(doc: PanResourceDoc): KkpanIdentityResolution {
  const rawKkpanId = doc.kkpan_id as unknown;
  const pair = validProviderPair(doc.provider_id, doc.provider_resource_id);
  const providerKkpanId = kkpanIdFromProviderPair(pair);

  if (!pair && hasMeaningfulProviderValue(doc)) {
    return {
      kind: "conflict",
      reason: "provider_id/provider_resource_id 不完整或格式无效",
    };
  }
  if (pair?.providerId === KKPAN_PLUGIN_ID && providerKkpanId == null) {
    return {
      kind: "conflict",
      reason: "KKPAN provider_resource_id 不是规范的正安全整数",
    };
  }
  if (isValidKkpanId(rawKkpanId)) {
    if (providerKkpanId != null && providerKkpanId !== rawKkpanId) {
      return {
        kind: "conflict",
        reason: `kkpan_id=${rawKkpanId} 与 provider_resource_id=${providerKkpanId} 不一致`,
      };
    }
    if (pair && pair.providerId !== KKPAN_PLUGIN_ID) {
      return {
        kind: "conflict",
        reason: `kkpan_id=${rawKkpanId} 与其它插件来源引用并存`,
      };
    }
    return { kind: "kkpan", kkpanId: rawKkpanId, pair };
  }
  if (providerKkpanId != null) {
    return { kind: "kkpan", kkpanId: providerKkpanId, pair };
  }
  if (doc.source === "kkpan") {
    return {
      kind: "conflict",
      reason: "source=kkpan 但没有可恢复的有效 KKPAN 来源 ID",
    };
  }
  return { kind: "other", pair };
}

function identityAnchors(doc: PanResourceDoc): {
  contentId?: string;
  doubanId?: string;
  internalId?: string;
} {
  const contentId =
    typeof doc.content_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      doc.content_id
    )
      ? doc.content_id.toLowerCase()
      : undefined;
  const doubanId =
    typeof doc.douban_id === "string" && /^\d{1,20}$/.test(doc.douban_id)
      ? doc.douban_id
      : undefined;
  const internalId =
    typeof doc.internal_id === "number" &&
    Number.isSafeInteger(doc.internal_id) &&
    doc.internal_id > 0
      ? String(doc.internal_id)
      : undefined;
  return { contentId, doubanId, internalId };
}

/** Only merge when every record shares at least one valid, unambiguous host identity. */
export function canAutoMergeKkpanGroup(group: readonly PanResourceDoc[]): boolean {
  const anchors = group.map(identityAnchors);
  let hasSharedAnchor = false;
  for (const field of ["contentId", "doubanId", "internalId"] as const) {
    const values = anchors.map((anchor) => anchor[field]);
    const known = new Set(values.filter((value): value is string => value != null));
    if (known.size > 1) return false;
    if (known.size === 1 && values.every((value) => value != null)) {
      hasSharedAnchor = true;
    }
  }
  return hasSharedAnchor;
}

function compareNewest(a: PanResourceDoc, b: PanResourceDoc): number {
  const byUpdatedAt = String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  if (byUpdatedAt !== 0) return byUpdatedAt;
  return String(b._id || "").localeCompare(String(a._id || ""));
}

/** Keep the freshest upstream representation; the migration deletes backed-up losers first. */
export function sortKkpanGroupForRetention(
  group: readonly PanResourceDoc[]
): PanResourceDoc[] {
  return [...group].sort(compareNewest);
}
