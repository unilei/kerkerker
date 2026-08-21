import type { Db } from "mongodb";

import { COLLECTIONS } from "@/lib/constants/db";
import {
  auditContentIdentityGraph,
  type ContentIdentityAuditIdentityInput,
  type ContentIdentityAuditInputs,
  type ContentIdentityAuditLinkInput,
  type ContentIdentityAuditReport,
} from "@/lib/content-identity-audit";
import { getDatabase } from "@/lib/db";

type AuditDocument = Record<string, unknown>;

function documentId(value: unknown): string {
  return value == null ? "(missing)" : String(value);
}

function toIdentityInput(doc: AuditDocument): ContentIdentityAuditIdentityInput {
  return {
    documentId: documentId(doc._id),
    content_id: doc.content_id,
    external_refs: doc.external_refs,
  };
}

function toLinkInput(doc: AuditDocument): ContentIdentityAuditLinkInput {
  return {
    documentId: documentId(doc._id),
    content_id: doc.content_id,
    douban_id: doc.douban_id,
    provider_id: doc.provider_id,
    provider_resource_id: doc.provider_resource_id,
    kkpan_id: doc.kkpan_id,
    source: doc.source,
  };
}

/**
 * Load only the fields needed by the read-only identity audit.
 *
 * The caller supplies a Db in tests and maintenance tooling; production
 * callers should use loadContentIdentityAuditReport so the database is opened
 * with skipInitialization and this audit never creates indexes as a side
 * effect.
 */
export async function loadContentIdentityAuditInputs(db: Db): Promise<ContentIdentityAuditInputs> {
  const [identities, panResources, panSyncTargets] = await Promise.all([
    db.collection<AuditDocument>(COLLECTIONS.CONTENT_IDENTITIES)
      .find({}, { projection: { content_id: 1, external_refs: 1 } })
      .toArray(),
    db.collection<AuditDocument>(COLLECTIONS.PAN_RESOURCES)
      .find({}, {
        projection: {
          content_id: 1,
          douban_id: 1,
          provider_id: 1,
          provider_resource_id: 1,
          kkpan_id: 1,
          source: 1,
        },
      })
      .toArray(),
    db.collection<AuditDocument>(COLLECTIONS.PAN_SYNC_TARGETS)
      .find({}, { projection: { content_id: 1, douban_id: 1 } })
      .toArray(),
  ]);

  return {
    identities: identities.map(toIdentityInput),
    panResources: panResources.map(toLinkInput),
    panSyncTargets: panSyncTargets.map(toLinkInput),
  };
}

/** Run the audit against the current Mongo snapshot without any writes. */
export async function loadContentIdentityAuditReport(): Promise<ContentIdentityAuditReport> {
  const db = await getDatabase({ skipInitialization: true });
  return auditContentIdentityGraph(await loadContentIdentityAuditInputs(db));
}
