import { randomUUID } from "node:crypto";
import type { Collection, Filter, ObjectId } from "mongodb";
import { COLLECTIONS } from "@/lib/constants/db";
import { getDatabase } from "@/lib/db";
import type { ExternalReference, HostContentReference } from "@/lib/plugins/types";

const PROVIDER_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const MAX_EXTERNAL_ID_LENGTH = 500;

export interface ContentExternalRefDoc {
  provider_id: string;
  external_id: string;
  canonical_url?: string;
  verified_at?: string;
}

export interface ContentIdentityDoc {
  _id?: ObjectId;
  content_id: string;
  external_refs: ContentExternalRefDoc[];
  created_at: string;
  updated_at: string;
}

export class ContentIdentityConflictError extends Error {
  readonly contentIds: readonly string[];

  constructor(contentIds: readonly string[]) {
    super("外部内容引用已经关联到不同的 content_id，需要人工处理");
    this.name = "ContentIdentityConflictError";
    this.contentIds = contentIds;
  }
}

export function isValidContentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function collection(): Promise<Collection<ContentIdentityDoc>> {
  return getDatabase().then((db) =>
    db.collection<ContentIdentityDoc>(COLLECTIONS.CONTENT_IDENTITIES)
  );
}

function normalizeExternalRef(ref: ExternalReference): ContentExternalRefDoc {
  const providerId = String(ref.providerId || "").trim();
  const externalId = String(ref.externalId || "").trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new RangeError("providerId 格式无效");
  }
  if (!externalId || externalId.length > MAX_EXTERNAL_ID_LENGTH || /[\u0000-\u001f]/.test(externalId)) {
    throw new RangeError("externalId 格式无效");
  }
  let canonicalUrl: string | undefined;
  if (ref.canonicalUrl) {
    const url = new URL(ref.canonicalUrl);
    if (!url.hostname || url.username || url.password || url.hash || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new RangeError("canonicalUrl 必须是 HTTP(S) URL");
    }
    canonicalUrl = url.toString();
  }
  return {
    provider_id: providerId,
    external_id: externalId,
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    ...(ref.verifiedAt ? { verified_at: ref.verifiedAt } : {}),
  };
}

function normalizeExternalRefs(refs: readonly ExternalReference[]): ContentExternalRefDoc[] {
  const deduped = new Map<string, ContentExternalRefDoc>();
  for (const ref of refs) {
    const normalized = normalizeExternalRef(ref);
    deduped.set(`${normalized.provider_id}\u0000${normalized.external_id}`, normalized);
  }
  if (deduped.size === 0) throw new RangeError("至少需要一个外部内容引用");
  return [...deduped.values()];
}

function externalRefFilter(refs: readonly ContentExternalRefDoc[]): Filter<ContentIdentityDoc> {
  return {
    $or: refs.map((ref) => ({
      external_refs: {
        $elemMatch: {
          provider_id: ref.provider_id,
          external_id: ref.external_id,
        },
      },
    })),
  };
}

function toHostReference(doc: ContentIdentityDoc): HostContentReference {
  return {
    contentId: doc.content_id,
    externalRefs: doc.external_refs.map((ref) => ({
      providerId: ref.provider_id,
      externalId: ref.external_id,
      canonicalUrl: ref.canonical_url,
      verifiedAt: ref.verified_at,
    })),
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000;
}

function refKey(ref: Pick<ContentExternalRefDoc, "provider_id" | "external_id">): string {
  return `${ref.provider_id}\u0000${ref.external_id}`;
}

/**
 * Attach all missing references in one conditional update. A batch update is
 * important here: if a later reference races with another identity, this call
 * must not leave the earlier references partially attached to the winner.
 */
async function attachMissingRefs(
  coll: Collection<ContentIdentityDoc>,
  contentId: string,
  refs: readonly ContentExternalRefDoc[]
): Promise<ContentIdentityDoc> {
  let pending = [...refs];
  for (let attempt = 0; attempt < 4 && pending.length > 0; attempt += 1) {
    const updated = await coll.findOneAndUpdate(
      {
        content_id: contentId,
        $and: pending.map((ref) => ({
          external_refs: {
            $not: {
              $elemMatch: {
                provider_id: ref.provider_id,
                external_id: ref.external_id,
              },
            },
          },
        })),
      } as Filter<ContentIdentityDoc>,
      {
        $push: { external_refs: { $each: pending } },
        $set: { updated_at: new Date().toISOString() },
      },
      { returnDocument: "after" }
    );
    if (updated) return updated;

    const current = await coll.findOne({ content_id: contentId });
    if (!current) throw new Error("宿主内容身份在写入过程中消失");
    const currentKeys = new Set(current.external_refs.map(refKey));
    pending = pending.filter((ref) => !currentKeys.has(refKey(ref)));
    if (pending.length === 0) return current;

    // If a pending ref moved to another identity while this document was
    // being updated, fail explicitly instead of silently splitting the graph.
    const conflicts = await coll.find(externalRefFilter(pending)).toArray();
    assertSingleIdentity(conflicts, contentId);
  }
  throw new Error("宿主内容身份引用并发更新过于频繁，请重试");
}

function assertSingleIdentity(
  docs: readonly ContentIdentityDoc[],
  expectedContentId?: string
): ContentIdentityDoc | undefined {
  const ids = [...new Set(docs.map((doc) => doc.content_id))];
  if (ids.length > 1 || (expectedContentId && ids.some((id) => id !== expectedContentId))) {
    throw new ContentIdentityConflictError(ids);
  }
  return docs[0];
}

/** Resolve exact provider/external IDs, creating one host identity when none exist. */
export async function resolveContentIdentity(
  refs: readonly ExternalReference[]
): Promise<HostContentReference> {
  const normalized = normalizeExternalRefs(refs);
  const coll = await collection();

  const existing = await coll.find(externalRefFilter(normalized)).toArray();
  const existingDoc = assertSingleIdentity(existing);

  if (existingDoc) {
    const knownKeys = new Set(existingDoc.external_refs.map(refKey));
    const additions = normalized.filter(
      (ref) => !knownKeys.has(refKey(ref))
    );
    if (additions.length > 0) {
      try {
        const updated = await attachMissingRefs(coll, existingDoc.content_id, additions);
        return toHostReference(updated);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const conflicts = await coll.find(externalRefFilter(normalized)).toArray();
        const winner = assertSingleIdentity(conflicts, existingDoc.content_id);
        if (!winner) throw error;
        return toHostReference(await attachMissingRefs(coll, winner.content_id, normalized));
      }
    }
    return toHostReference(existingDoc);
  }

  const now = new Date().toISOString();
  const doc: ContentIdentityDoc = {
    content_id: randomUUID(),
    external_refs: normalized,
    created_at: now,
    updated_at: now,
  };
  try {
    await coll.insertOne(doc);
    return toHostReference(doc);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const raced = await coll.find(externalRefFilter(normalized)).toArray();
    const winner = assertSingleIdentity(raced);
    if (!winner) throw error;
    try {
      return toHostReference(await attachMissingRefs(coll, winner.content_id, normalized));
    } catch (attachError) {
      if (isDuplicateKey(attachError)) {
        const conflicts = await coll.find(externalRefFilter(normalized)).toArray();
        const stableWinner = assertSingleIdentity(conflicts, winner.content_id);
        if (stableWinner) return toHostReference(stableWinner);
      }
      throw attachError;
    }
  }
}

export async function findContentIdentityByExternalRef(
  ref: ExternalReference
): Promise<HostContentReference | null> {
  const normalized = normalizeExternalRef(ref);
  const coll = await collection();
  const doc = await coll.findOne(externalRefFilter([normalized]));
  return doc ? toHostReference(doc) : null;
}

export async function findContentIdentityById(
  contentId: string
): Promise<HostContentReference | null> {
  if (!isValidContentId(contentId)) {
    return null;
  }
  const coll = await collection();
  const doc = await coll.findOne({ content_id: contentId });
  return doc ? toHostReference(doc) : null;
}
