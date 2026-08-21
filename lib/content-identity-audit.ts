import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import { isValidContentId } from "@/lib/content-identity-db";

const DOUBAN_ID_PATTERN = /^\d{1,20}$/;
const PROVIDER_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const MAX_EXTERNAL_ID_LENGTH = 500;

export type ContentAuditCollection =
  | "content_identities"
  | "pan_resources"
  | "pan_sync_targets";

export interface ContentIdentityAuditIdentityInput {
  documentId: string;
  content_id?: unknown;
  external_refs?: unknown;
}

export interface ContentIdentityAuditLinkInput {
  documentId: string;
  content_id?: unknown;
  douban_id?: unknown;
  provider_id?: unknown;
  provider_resource_id?: unknown;
  kkpan_id?: unknown;
  source?: unknown;
}

export interface ContentIdentityAuditInputs {
  identities: readonly ContentIdentityAuditIdentityInput[];
  panResources: readonly ContentIdentityAuditLinkInput[];
  panSyncTargets: readonly ContentIdentityAuditLinkInput[];
}

export type ContentIdentityAuditIssueCode =
  | "identity.invalid_content_id"
  | "identity.missing_external_refs"
  | "identity.invalid_external_ref"
  | "identity.duplicate_content_id"
  | "identity.duplicate_external_ref"
  | "link.invalid_content_id"
  | "link.content_id_without_identity"
  | "link.content_id_has_multiple_identities"
  | "link.invalid_douban_id"
  | "link.douban_id_without_identity"
  | "link.douban_id_has_multiple_identities"
  | "link.content_douban_mismatch"
  | "link.missing_content_and_external_id"
  | "link.provider_pair_invalid"
  | "link.provider_pair_duplicate"
  | "link.kkpan_identity_invalid"
  | "link.kkpan_identity_mismatch"
  | "link.douban_maps_to_multiple_content_ids";

export interface ContentIdentityAuditIssue {
  collection: ContentAuditCollection;
  documentId: string;
  code: ContentIdentityAuditIssueCode;
  severity: "conflict";
  message: string;
  contentId?: string;
  doubanId?: string;
  providerId?: string;
  providerResourceId?: string;
}

export interface ContentIdentityCollectionSummary {
  total: number;
  contentIdPresent: number;
  contentIdMissing: number;
  contentIdInvalid: number;
  contentIdConsistent: number;
  contentIdPendingBackfill: number;
  contentIdConflict: number;
  doubanIdPresent: number;
  doubanIdMissing: number;
  doubanIdInvalid: number;
  contentOnly: number;
  providerPairComplete: number;
  providerPairMissing: number;
  providerPairInvalid: number;
  kkpanIdentityComplete: number;
  kkpanIdentityRecoverable: number;
  kkpanIdentityConflict: number;
  duplicateProviderPairs: number;
}

export interface ContentIdentityAuditReport {
  scope: readonly ContentAuditCollection[];
  identities: {
    total: number;
    valid: number;
    invalidContentId: number;
    missingExternalRefs: number;
    invalidExternalRefs: number;
    duplicateContentIds: number;
    duplicateExternalRefs: number;
    orphanIdentities: number;
  };
  collections: Record<"pan_resources" | "pan_sync_targets", ContentIdentityCollectionSummary>;
  pendingBackfill: number;
  blockingConflictCount: number;
  oldDoubanLinkCount: number;
  issues: readonly ContentIdentityAuditIssue[];
}

interface ParsedIdentity {
  documentId: string;
  contentId: string;
  refs: Set<string>;
}

interface ParsedLink {
  collection: "pan_resources" | "pan_sync_targets";
  documentId: string;
  contentId?: string;
  doubanId?: string;
  providerId?: string;
  providerResourceId?: string;
  kkpanId?: number;
  sourceIsKkpan: boolean;
}

function refKey(providerId: string, externalId: string): string {
  return `${providerId}\u0000${externalId}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value);
}

function validExternalId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_EXTERNAL_ID_LENGTH &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function validKkpanId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function incrementSummary<K extends keyof ContentIdentityCollectionSummary>(
  summary: ContentIdentityCollectionSummary,
  key: K
): void {
  summary[key] = (summary[key] + 1) as ContentIdentityCollectionSummary[K];
}

function emptyCollectionSummary(): ContentIdentityCollectionSummary {
  return {
    total: 0,
    contentIdPresent: 0,
    contentIdMissing: 0,
    contentIdInvalid: 0,
    contentIdConsistent: 0,
    contentIdPendingBackfill: 0,
    contentIdConflict: 0,
    doubanIdPresent: 0,
    doubanIdMissing: 0,
    doubanIdInvalid: 0,
    contentOnly: 0,
    providerPairComplete: 0,
    providerPairMissing: 0,
    providerPairInvalid: 0,
    kkpanIdentityComplete: 0,
    kkpanIdentityRecoverable: 0,
    kkpanIdentityConflict: 0,
    duplicateProviderPairs: 0,
  };
}

function issue(
  issues: ContentIdentityAuditIssue[],
  value: Omit<ContentIdentityAuditIssue, "severity">
): void {
  issues.push({ ...value, severity: "conflict" });
}

function parseIdentityRefs(
  identity: ContentIdentityAuditIdentityInput,
  issues: ContentIdentityAuditIssue[]
): { parsed?: ParsedIdentity; invalidRefs: number } {
  const contentId = nonEmptyString(identity.content_id);
  if (!contentId || !isValidContentId(contentId)) {
    issue(issues, {
      collection: "content_identities",
      documentId: identity.documentId,
      code: "identity.invalid_content_id",
      message: "身份文档的 content_id 缺失或不是有效 UUID",
      ...(contentId ? { contentId } : {}),
    });
    return { invalidRefs: 0 };
  }

  if (!Array.isArray(identity.external_refs) || identity.external_refs.length === 0) {
    issue(issues, {
      collection: "content_identities",
      documentId: identity.documentId,
      code: "identity.missing_external_refs",
      message: "身份文档没有外部引用",
      contentId,
    });
    return { parsed: { documentId: identity.documentId, contentId, refs: new Set() }, invalidRefs: 0 };
  }

  const refs = new Set<string>();
  let invalidRefs = 0;
  for (const rawRef of identity.external_refs) {
    const value = rawRef && typeof rawRef === "object" && !Array.isArray(rawRef)
      ? rawRef as Record<string, unknown>
      : undefined;
    const providerId = nonEmptyString(value?.provider_id);
    const externalId = nonEmptyString(value?.external_id);
    const valid = Boolean(
      providerId &&
      validProviderId(providerId) &&
      externalId &&
      validExternalId(externalId) &&
      (providerId !== DOUBAN_CONTENT_PLUGIN_ID || DOUBAN_ID_PATTERN.test(externalId))
    );
    if (!valid || !providerId || !externalId) {
      invalidRefs += 1;
      issue(issues, {
        collection: "content_identities",
        documentId: identity.documentId,
        code: "identity.invalid_external_ref",
        message: "身份文档包含格式无效的外部引用",
        contentId,
      });
      continue;
    }
    const key = refKey(providerId, externalId);
    if (refs.has(key)) {
      issue(issues, {
        collection: "content_identities",
        documentId: identity.documentId,
        code: "identity.duplicate_external_ref",
        message: "同一身份文档包含重复的外部引用",
        contentId,
        providerId,
        providerResourceId: externalId,
      });
      continue;
    }
    refs.add(key);
  }
  return { parsed: { documentId: identity.documentId, contentId, refs }, invalidRefs };
}

function parseLink(
  collection: "pan_resources" | "pan_sync_targets",
  input: ContentIdentityAuditLinkInput
): ParsedLink {
  const rawContentId = nonEmptyString(input.content_id);
  const rawDoubanId = nonEmptyString(input.douban_id);
  const providerId = nonEmptyString(input.provider_id);
  const providerResourceId = nonEmptyString(input.provider_resource_id);
  return {
    collection,
    documentId: input.documentId,
    ...(rawContentId ? { contentId: rawContentId } : {}),
    ...(rawDoubanId ? { doubanId: rawDoubanId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerResourceId ? { providerResourceId } : {}),
    ...(validKkpanId(input.kkpan_id) ? { kkpanId: input.kkpan_id } : {}),
    sourceIsKkpan: input.source === "kkpan",
  };
}

function providerPairKey(link: ParsedLink): string | undefined {
  if (!link.providerId && !link.providerResourceId) return undefined;
  if (!link.providerId || !link.providerResourceId) return undefined;
  if (!validProviderId(link.providerId) || !validExternalId(link.providerResourceId)) return undefined;
  return refKey(link.providerId, link.providerResourceId);
}

function analyzeLink(
  link: ParsedLink,
  summary: ContentIdentityCollectionSummary,
  identitiesByContentId: ReadonlyMap<string, ParsedIdentity[]>,
  identitiesByRef: ReadonlyMap<string, ParsedIdentity[]>,
  issues: ContentIdentityAuditIssue[]
): void {
  summary.total += 1;
  const hasRawContentId = link.contentId !== undefined;
  const contentIdValid = hasRawContentId && isValidContentId(link.contentId!);
  if (contentIdValid) incrementSummary(summary, "contentIdPresent");
  else if (hasRawContentId) {
    incrementSummary(summary, "contentIdInvalid");
    issue(issues, {
      collection: link.collection,
      documentId: link.documentId,
      code: "link.invalid_content_id",
      message: "记录的 content_id 不是有效 UUID",
      contentId: link.contentId,
    });
  } else incrementSummary(summary, "contentIdMissing");

  const hasRawDoubanId = link.doubanId !== undefined;
  const doubanValid = hasRawDoubanId && DOUBAN_ID_PATTERN.test(link.doubanId!);
  if (doubanValid) incrementSummary(summary, "doubanIdPresent");
  else if (hasRawDoubanId) {
    incrementSummary(summary, "doubanIdInvalid");
    issue(issues, {
      collection: link.collection,
      documentId: link.documentId,
      code: "link.invalid_douban_id",
      message: "记录的 douban_id 不是规范的数字外部 ID",
      ...(link.doubanId ? { doubanId: link.doubanId } : {}),
    });
  } else incrementSummary(summary, "doubanIdMissing");

  if (contentIdValid && !doubanValid) incrementSummary(summary, "contentOnly");

  const contentOwners = contentIdValid ? identitiesByContentId.get(link.contentId!) || [] : [];
  const doubanOwners = doubanValid
    ? identitiesByRef.get(refKey(DOUBAN_CONTENT_PLUGIN_ID, link.doubanId!)) || []
    : [];
  if (contentIdValid) {
    if (contentOwners.length === 0) {
      summary.contentIdConflict += 1;
      issue(issues, {
        collection: link.collection,
        documentId: link.documentId,
        code: "link.content_id_without_identity",
        message: "content_id 没有对应的宿主身份文档",
        contentId: link.contentId,
        ...(doubanValid ? { doubanId: link.doubanId } : {}),
      });
    } else if (contentOwners.length > 1) {
      summary.contentIdConflict += 1;
      issue(issues, {
        collection: link.collection,
        documentId: link.documentId,
        code: "link.content_id_has_multiple_identities",
        message: "content_id 对应多个宿主身份文档",
        contentId: link.contentId,
      });
    }
  }

  if (doubanValid && doubanOwners.length === 0) {
    if (contentIdValid) {
      summary.contentIdConflict += 1;
      issue(issues, {
        collection: link.collection,
        documentId: link.documentId,
        code: "link.douban_id_without_identity",
        message: "douban_id 没有对应身份引用，不能证明 content_id 归属",
        contentId: link.contentId,
        doubanId: link.doubanId,
      });
    } else {
      summary.contentIdPendingBackfill += 1;
    }
  } else if (doubanValid && doubanOwners.length > 1) {
    summary.contentIdConflict += 1;
    issue(issues, {
      collection: link.collection,
      documentId: link.documentId,
      code: "link.douban_id_has_multiple_identities",
      message: "douban_id 对应多个宿主身份文档",
      ...(contentIdValid ? { contentId: link.contentId } : {}),
      doubanId: link.doubanId,
    });
  }

  if (!contentIdValid && doubanValid && doubanOwners.length === 1) {
    summary.contentIdPendingBackfill += 1;
  } else if (contentIdValid && doubanValid && contentOwners.length === 1 && doubanOwners.length === 1) {
    if (contentOwners[0].contentId === doubanOwners[0].contentId) {
      summary.contentIdConsistent += 1;
    } else {
      summary.contentIdConflict += 1;
      issue(issues, {
        collection: link.collection,
        documentId: link.documentId,
        code: "link.content_douban_mismatch",
        message: "content_id 与 douban_id 指向不同身份",
        contentId: link.contentId,
        doubanId: link.doubanId,
      });
    }
  }

  const pairPresent = Boolean(link.providerId || link.providerResourceId);
  const pairKey = providerPairKey(link);
  if (pairKey) incrementSummary(summary, "providerPairComplete");
  else if (pairPresent) {
    incrementSummary(summary, link.providerId && link.providerResourceId ? "providerPairInvalid" : "providerPairMissing");
    issue(issues, {
      collection: link.collection,
      documentId: link.documentId,
      code: "link.provider_pair_invalid",
      message: "provider_id/provider_resource_id 缺失、格式无效或不完整",
      ...(link.providerId ? { providerId: link.providerId } : {}),
      ...(link.providerResourceId ? { providerResourceId: link.providerResourceId } : {}),
    });
  } else incrementSummary(summary, "providerPairMissing");

  const providerKkpanId =
    link.providerId === KKPAN_PLUGIN_ID && link.providerResourceId && /^[1-9]\d*$/.test(link.providerResourceId)
      ? Number(link.providerResourceId)
      : undefined;
  const providerKkpanIdValid =
    providerKkpanId !== undefined && validKkpanId(providerKkpanId) && String(providerKkpanId) === link.providerResourceId;
  if (link.kkpanId !== undefined || link.sourceIsKkpan || link.providerId === KKPAN_PLUGIN_ID) {
    if (link.kkpanId !== undefined && providerKkpanIdValid && link.kkpanId !== providerKkpanId) {
      summary.kkpanIdentityConflict += 1;
      issue(issues, {
        collection: link.collection,
        documentId: link.documentId,
        code: "link.kkpan_identity_mismatch",
        message: "kkpan_id 与 provider_resource_id 不一致",
        providerId: link.providerId,
        providerResourceId: link.providerResourceId,
      });
    } else if (link.kkpanId !== undefined && link.providerId && link.providerId !== KKPAN_PLUGIN_ID) {
      summary.kkpanIdentityConflict += 1;
      issue(issues, {
        collection: link.collection,
        documentId: link.documentId,
        code: "link.kkpan_identity_mismatch",
        message: "kkpan_id 与其它来源 provider 引用并存",
        providerId: link.providerId,
        providerResourceId: link.providerResourceId,
      });
    } else if (link.sourceIsKkpan && !validKkpanId(link.kkpanId) && !providerKkpanIdValid) {
      summary.kkpanIdentityConflict += 1;
      issue(issues, {
        collection: link.collection,
        documentId: link.documentId,
        code: "link.kkpan_identity_invalid",
        message: "source=kkpan 但没有可验证的正整数来源 ID",
        providerId: link.providerId,
        providerResourceId: link.providerResourceId,
      });
    } else if (providerKkpanIdValid && link.kkpanId === undefined) {
      summary.kkpanIdentityRecoverable += 1;
    } else if (validKkpanId(link.kkpanId) || providerKkpanIdValid) {
      summary.kkpanIdentityComplete += 1;
    }
  }
}

/**
 * Analyze the current identity graph without touching MongoDB or generating IDs.
 * Missing content_id values are pending migration; only contradictions block it.
 */
export function auditContentIdentityGraph(
  input: ContentIdentityAuditInputs
): ContentIdentityAuditReport {
  const issues: ContentIdentityAuditIssue[] = [];
  const identitiesByContentId = new Map<string, ParsedIdentity[]>();
  const identitiesByRef = new Map<string, ParsedIdentity[]>();
  const identityCounts = {
    total: input.identities.length,
    valid: 0,
    invalidContentId: 0,
    missingExternalRefs: 0,
    invalidExternalRefs: 0,
    duplicateContentIds: 0,
    duplicateExternalRefs: 0,
    orphanIdentities: 0,
  };

  for (const identity of input.identities) {
    const parsedResult = parseIdentityRefs(identity, issues);
    if (!parsedResult.parsed) {
      identityCounts.invalidContentId += 1;
      continue;
    }
    const parsed = parsedResult.parsed;
    identityCounts.valid += 1;
    identityCounts.invalidExternalRefs += parsedResult.invalidRefs;
    if (parsed.refs.size === 0) {
      identityCounts.missingExternalRefs += 1;
      identityCounts.orphanIdentities += 1;
    }
    const contentOwners = identitiesByContentId.get(parsed.contentId) || [];
    contentOwners.push(parsed);
    identitiesByContentId.set(parsed.contentId, contentOwners);
    for (const key of parsed.refs) {
      const owners = identitiesByRef.get(key) || [];
      owners.push(parsed);
      identitiesByRef.set(key, owners);
    }
  }

  for (const owners of identitiesByContentId.values()) {
    if (owners.length <= 1) continue;
    identityCounts.duplicateContentIds += owners.length;
    for (const owner of owners) {
      issue(issues, {
        collection: "content_identities",
        documentId: owner.documentId,
        code: "identity.duplicate_content_id",
        message: "同一 content_id 存在于多个身份文档",
        contentId: owner.contentId,
      });
    }
  }
  for (const [key, owners] of identitiesByRef) {
    if (owners.length <= 1) continue;
    identityCounts.duplicateExternalRefs += owners.length;
    const [providerId, providerResourceId] = key.split("\u0000");
    for (const owner of owners) {
      issue(issues, {
        collection: "content_identities",
        documentId: owner.documentId,
        code: "identity.duplicate_external_ref",
        message: "同一外部引用存在于多个身份文档",
        contentId: owner.contentId,
        providerId,
        providerResourceId,
      });
    }
  }

  const parsedCollections = {
    pan_resources: input.panResources.map((link) => parseLink("pan_resources", link)),
    pan_sync_targets: input.panSyncTargets.map((link) => parseLink("pan_sync_targets", link)),
  } as const;
  const providerPairOwners = new Map<string, ParsedLink[]>();
  for (const links of Object.values(parsedCollections)) {
    for (const link of links) {
      const key = providerPairKey(link);
      if (key) {
        const owners = providerPairOwners.get(key) || [];
        owners.push(link);
        providerPairOwners.set(key, owners);
      }
    }
  }
  for (const [key, owners] of providerPairOwners) {
    if (owners.length <= 1) continue;
    const [providerId, providerResourceId] = key.split("\u0000");
    for (const owner of owners) {
      issue(issues, {
        collection: owner.collection,
        documentId: owner.documentId,
        code: "link.provider_pair_duplicate",
        message: "同一 provider_id/provider_resource_id 被多个记录占用",
        providerId,
        providerResourceId,
      });
    }
  }

  const collections = {
    pan_resources: emptyCollectionSummary(),
    pan_sync_targets: emptyCollectionSummary(),
  };
  for (const [collection, links] of Object.entries(parsedCollections) as Array<[
    "pan_resources" | "pan_sync_targets",
    readonly ParsedLink[]
  ]>) {
    for (const link of links) {
      analyzeLink(link, collections[collection], identitiesByContentId, identitiesByRef, issues);
    }
    for (const link of links) {
      const key = providerPairKey(link);
      if (key && (providerPairOwners.get(key)?.length || 0) > 1) {
        collections[collection].duplicateProviderPairs += 1;
      }
    }
  }

  const doubanContentOwners = new Map<string, Set<string>>();
  for (const links of Object.values(parsedCollections)) {
    for (const link of links) {
      if (!link.doubanId || !link.contentId || !isValidContentId(link.contentId)) continue;
      const ids = doubanContentOwners.get(link.doubanId) || new Set<string>();
      ids.add(link.contentId);
      doubanContentOwners.set(link.doubanId, ids);
    }
  }
  for (const [doubanId, contentIds] of doubanContentOwners) {
    if (contentIds.size <= 1) continue;
    for (const links of Object.values(parsedCollections)) {
      for (const link of links) {
        if (link.doubanId !== doubanId || !link.contentId) continue;
        issue(issues, {
          collection: link.collection,
          documentId: link.documentId,
          code: "link.douban_maps_to_multiple_content_ids",
          message: "同一 douban_id 在关联记录中指向多个 content_id",
          contentId: link.contentId,
          doubanId,
        });
      }
    }
  }

  const oldDoubanLinkCount =
    collections.pan_resources.doubanIdPresent + collections.pan_sync_targets.doubanIdPresent;
  const pendingBackfill =
    collections.pan_resources.contentIdPendingBackfill + collections.pan_sync_targets.contentIdPendingBackfill;
  return {
    scope: ["content_identities", "pan_resources", "pan_sync_targets"],
    identities: identityCounts,
    collections,
    pendingBackfill,
    blockingConflictCount: issues.length,
    oldDoubanLinkCount,
    issues,
  };
}
