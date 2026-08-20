import { randomUUID } from "node:crypto";
import { isValidContentId } from "@/lib/content-identity-db";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";

const DOUBAN_ID_PATTERN = /^\d{1,20}$/;
const PROVIDER_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const MAX_EXTERNAL_ID_LENGTH = 500;

export type ContentBackfillCollection = "pan_sync_targets" | "pan_resources";

export interface LegacyContentLinkRecord {
  collection: ContentBackfillCollection;
  documentId: string;
  doubanId: unknown;
  contentId: unknown;
}

export interface ExistingContentIdentityRecord {
  documentId: string;
  contentId: unknown;
  externalRefs: unknown;
}

export interface ContentBackfillConflict {
  scope: "identity" | ContentBackfillCollection;
  documentId: string;
  doubanId?: string;
  reason: string;
}

export interface ContentBackfillAssignment {
  collection: ContentBackfillCollection;
  documentId: string;
  doubanId: string;
  contentId: string;
}

export interface NewContentIdentity {
  doubanId: string;
  contentId: string;
}

export interface ContentIdentityBackfillPlan {
  assignments: ContentBackfillAssignment[];
  newIdentities: NewContentIdentity[];
  conflicts: ContentBackfillConflict[];
  alreadyConsistent: number;
}

interface ParsedIdentity {
  documentId: string;
  contentId: string;
}

interface ParsedLegacyRecord {
  record: LegacyContentLinkRecord;
  doubanId: string;
  contentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function refKey(providerId: string, externalId: string): string {
  return `${providerId}\u0000${externalId}`;
}

function addConflict(
  conflicts: ContentBackfillConflict[],
  conflict: ContentBackfillConflict
): void {
  conflicts.push(conflict);
}

/**
 * Build a deterministic, read-only migration plan. Existing non-empty
 * content_id values are evidence to audit, never values this planner repairs.
 */
export function planContentIdentityBackfill(
  records: readonly LegacyContentLinkRecord[],
  identities: readonly ExistingContentIdentityRecord[],
  createContentId: () => string = randomUUID
): ContentIdentityBackfillPlan {
  const conflicts: ContentBackfillConflict[] = [];
  const identitiesByContentId = new Map<string, ParsedIdentity[]>();
  const identitiesByRef = new Map<string, ParsedIdentity[]>();

  for (const identity of identities) {
    if (typeof identity.contentId !== "string" || !isValidContentId(identity.contentId)) {
      addConflict(conflicts, {
        scope: "identity",
        documentId: identity.documentId,
        reason: "content_id 不是有效 UUID",
      });
      continue;
    }
    if (!Array.isArray(identity.externalRefs) || identity.externalRefs.length === 0) {
      addConflict(conflicts, {
        scope: "identity",
        documentId: identity.documentId,
        reason: "external_refs 缺失或为空",
      });
      continue;
    }

    const parsed: ParsedIdentity = {
      documentId: identity.documentId,
      contentId: identity.contentId,
    };
    const contentOwners = identitiesByContentId.get(parsed.contentId) || [];
    contentOwners.push(parsed);
    identitiesByContentId.set(parsed.contentId, contentOwners);

    const seenRefs = new Set<string>();
    for (const rawRef of identity.externalRefs) {
      if (!isRecord(rawRef)) {
        addConflict(conflicts, {
          scope: "identity",
          documentId: identity.documentId,
          reason: "external_refs 包含非对象成员",
        });
        continue;
      }
      const providerId = rawRef.provider_id;
      const externalId = rawRef.external_id;
      if (
        typeof providerId !== "string" ||
        !PROVIDER_ID_PATTERN.test(providerId) ||
        typeof externalId !== "string" ||
        !externalId ||
        externalId.length > MAX_EXTERNAL_ID_LENGTH ||
        /[\u0000-\u001f]/.test(externalId)
      ) {
        addConflict(conflicts, {
          scope: "identity",
          documentId: identity.documentId,
          reason: "external_refs 包含格式无效的来源引用",
        });
        continue;
      }
      if (
        providerId === DOUBAN_CONTENT_PLUGIN_ID &&
        !DOUBAN_ID_PATTERN.test(externalId)
      ) {
        addConflict(conflicts, {
          scope: "identity",
          documentId: identity.documentId,
          doubanId: externalId,
          reason: "豆瓣 external_id 格式无效",
        });
        continue;
      }

      const key = refKey(providerId, externalId);
      if (seenRefs.has(key)) {
        addConflict(conflicts, {
          scope: "identity",
          documentId: identity.documentId,
          ...(providerId === DOUBAN_CONTENT_PLUGIN_ID ? { doubanId: externalId } : {}),
          reason: "同一身份包含重复的外部引用",
        });
        continue;
      }
      seenRefs.add(key);
      const refOwners = identitiesByRef.get(key) || [];
      refOwners.push(parsed);
      identitiesByRef.set(key, refOwners);
    }
  }

  for (const [contentId, owners] of identitiesByContentId) {
    if (owners.length <= 1) continue;
    for (const owner of owners) {
      addConflict(conflicts, {
        scope: "identity",
        documentId: owner.documentId,
        reason: `content_id ${contentId} 存在于多个身份文档`,
      });
    }
  }
  for (const owners of identitiesByRef.values()) {
    if (owners.length <= 1) continue;
    for (const owner of owners) {
      addConflict(conflicts, {
        scope: "identity",
        documentId: owner.documentId,
        reason: "同一外部引用指向多个身份文档",
      });
    }
  }

  const parsedRecords: ParsedLegacyRecord[] = [];
  const blockedDoubanIds = new Set<string>();
  for (const record of records) {
    if (typeof record.doubanId !== "string" || !DOUBAN_ID_PATTERN.test(record.doubanId)) {
      addConflict(conflicts, {
        scope: record.collection,
        documentId: record.documentId,
        reason: "douban_id 缺失或格式无效",
      });
      continue;
    }

    let contentId: string | undefined;
    if (record.contentId !== undefined && record.contentId !== null && record.contentId !== "") {
      if (typeof record.contentId !== "string" || !isValidContentId(record.contentId)) {
        addConflict(conflicts, {
          scope: record.collection,
          documentId: record.documentId,
          doubanId: record.doubanId,
          reason: "已有 content_id 不是有效 UUID",
        });
        blockedDoubanIds.add(record.doubanId);
      } else {
        contentId = record.contentId;
      }
    }
    parsedRecords.push({ record, doubanId: record.doubanId, contentId });
  }

  let alreadyConsistent = 0;
  for (const parsed of parsedRecords) {
    if (!parsed.contentId) continue;
    const contentOwners = identitiesByContentId.get(parsed.contentId) || [];
    const refOwners = identitiesByRef.get(
      refKey(DOUBAN_CONTENT_PLUGIN_ID, parsed.doubanId)
    ) || [];
    if (contentOwners.length !== 1) {
      addConflict(conflicts, {
        scope: parsed.record.collection,
        documentId: parsed.record.documentId,
        doubanId: parsed.doubanId,
        reason: contentOwners.length === 0
          ? "已有 content_id 没有对应的身份文档"
          : "已有 content_id 对应多个身份文档",
      });
      blockedDoubanIds.add(parsed.doubanId);
      continue;
    }
    if (refOwners.length !== 1) {
      addConflict(conflicts, {
        scope: parsed.record.collection,
        documentId: parsed.record.documentId,
        doubanId: parsed.doubanId,
        reason: refOwners.length === 0
          ? "身份文档未绑定该豆瓣外部引用，不能自动推断"
          : "豆瓣外部引用对应多个身份文档",
      });
      blockedDoubanIds.add(parsed.doubanId);
      continue;
    }
    if (contentOwners[0].contentId !== refOwners[0].contentId) {
      addConflict(conflicts, {
        scope: parsed.record.collection,
        documentId: parsed.record.documentId,
        doubanId: parsed.doubanId,
        reason: "已有 content_id 与豆瓣外部引用指向不同身份",
      });
      blockedDoubanIds.add(parsed.doubanId);
      continue;
    }
    alreadyConsistent += 1;
  }

  const usedContentIds = new Set(identitiesByContentId.keys());
  const newIdentityByDoubanId = new Map<string, NewContentIdentity>();
  const assignments: ContentBackfillAssignment[] = [];
  for (const parsed of parsedRecords) {
    if (parsed.contentId || blockedDoubanIds.has(parsed.doubanId)) continue;
    const refOwners = identitiesByRef.get(
      refKey(DOUBAN_CONTENT_PLUGIN_ID, parsed.doubanId)
    ) || [];
    if (refOwners.length > 1) continue;

    let contentId = refOwners[0]?.contentId;
    if (!contentId) {
      let planned = newIdentityByDoubanId.get(parsed.doubanId);
      if (!planned) {
        let generated = "";
        for (let attempt = 0; attempt < 10; attempt += 1) {
          generated = createContentId();
          if (isValidContentId(generated) && !usedContentIds.has(generated)) break;
          generated = "";
        }
        if (!generated) {
          throw new Error("无法生成唯一的 content_id");
        }
        usedContentIds.add(generated);
        planned = { doubanId: parsed.doubanId, contentId: generated };
        newIdentityByDoubanId.set(parsed.doubanId, planned);
      }
      contentId = planned.contentId;
    }
    assignments.push({
      collection: parsed.record.collection,
      documentId: parsed.record.documentId,
      doubanId: parsed.doubanId,
      contentId,
    });
  }

  return {
    assignments: assignments.sort((a, b) =>
      `${a.collection}:${a.documentId}`.localeCompare(`${b.collection}:${b.documentId}`)
    ),
    newIdentities: [...newIdentityByDoubanId.values()].sort((a, b) =>
      a.doubanId.localeCompare(b.doubanId)
    ),
    conflicts,
    alreadyConsistent,
  };
}
