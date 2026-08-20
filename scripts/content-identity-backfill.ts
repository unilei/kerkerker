/**
 * Audit and backfill host content_id for legacy Douban-linked records.
 * Preview is read-only. Applying requires stopped writers and an explicit
 * maintenance acknowledgement:
 *
 *   npx tsx scripts/content-identity-backfill.ts
 *   npx tsx scripts/content-identity-backfill.ts --apply --maintenance
 */

import "dotenv/config";
import type {
  Db,
  Filter,
  IndexDescriptionInfo,
  IndexSpecification,
} from "mongodb";
import { closeDatabase, getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import type { ContentIdentityDoc } from "@/lib/content-identity-db";
import {
  planContentIdentityBackfill,
  type ContentIdentityBackfillPlan,
  type LegacyContentLinkRecord,
} from "@/lib/content-identity-backfill-plan";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";
import type { PanResourceDoc } from "@/lib/pan-resources-db";
import type { PanSyncTargetDoc } from "@/lib/pan/catalog-sync";

const apply = process.argv.includes("--apply");
const maintenance = process.argv.includes("--maintenance");
const MAX_PRINTED_CONFLICTS = 100;

interface LoadedState {
  plan: ContentIdentityBackfillPlan;
  targetDocs: Map<string, PanSyncTargetDoc>;
  resourceDocs: Map<string, PanResourceDoc>;
}

function hasExactKey(
  index: IndexDescriptionInfo,
  expected: readonly (readonly [string, number])[]
): boolean {
  const actual = Object.entries(index.key || {});
  return actual.length === expected.length && expected.every(
    ([field, direction], position) =>
      actual[position]?.[0] === field && actual[position]?.[1] === direction
  );
}

async function ensureIdentityUniqueIndexes(db: Db): Promise<void> {
  const collection = db.collection<ContentIdentityDoc>(COLLECTIONS.CONTENT_IDENTITIES);
  const exists = await db.listCollections(
    { name: COLLECTIONS.CONTENT_IDENTITIES },
    { nameOnly: true }
  ).hasNext();
  const indexes = exists ? await collection.listIndexes().toArray() : [];
  const requirements: Array<{
    key: readonly (readonly [string, number])[];
    spec: IndexSpecification;
    name: string;
  }> = [
    {
      key: [["content_id", 1]] as const,
      spec: { content_id: 1 },
      name: "content_id_1",
    },
    {
      key: [
        ["external_refs.provider_id", 1],
        ["external_refs.external_id", 1],
      ] as const,
      spec: {
        "external_refs.provider_id": 1,
        "external_refs.external_id": 1,
      },
      name: "external_refs.provider_id_1_external_refs.external_id_1",
    },
  ];

  for (const requirement of requirements) {
    const sameKey = indexes.filter((index) => hasExactKey(index, requirement.key));
    const desired = sameKey.filter(
      (index) =>
        index.unique === true &&
        index.sparse !== true &&
        index.hidden !== true &&
        index.partialFilterExpression == null &&
        index.collation == null
    );
    if (sameKey.length > 0 && desired.length === 0) {
      throw new Error(
        `身份索引 ${requirement.name} 选项不符合完整唯一约束；脚本不会自动删除或替换索引`
      );
    }
    if (desired.length > 0) continue;
    await collection.createIndex(requirement.spec, {
      unique: true,
      name: requirement.name,
    });
  }
}

async function loadState(db: Db): Promise<LoadedState> {
  const targets = db.collection<PanSyncTargetDoc>(COLLECTIONS.PAN_SYNC_TARGETS);
  const resources = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const identities = db.collection<ContentIdentityDoc>(COLLECTIONS.CONTENT_IDENTITIES);
  const [targetDocs, resourceDocs, identityDocs] = await Promise.all([
    targets.find({}, { projection: { douban_id: 1, content_id: 1 } }).toArray(),
    resources.find({}, { projection: { douban_id: 1, content_id: 1 } }).toArray(),
    identities.find({}, { projection: { content_id: 1, external_refs: 1 } }).toArray(),
  ]);

  const records: LegacyContentLinkRecord[] = [
    ...targetDocs.map((doc) => ({
      collection: "pan_sync_targets" as const,
      documentId: String(doc._id),
      doubanId: doc.douban_id,
      contentId: doc.content_id,
    })),
    ...resourceDocs.map((doc) => ({
      collection: "pan_resources" as const,
      documentId: String(doc._id),
      doubanId: doc.douban_id,
      contentId: doc.content_id,
    })),
  ];
  const plan = planContentIdentityBackfill(
    records,
    identityDocs.map((doc) => ({
      documentId: String(doc._id),
      contentId: doc.content_id,
      externalRefs: doc.external_refs,
    }))
  );

  return {
    plan,
    targetDocs: new Map(targetDocs.map((doc) => [String(doc._id), doc])),
    resourceDocs: new Map(resourceDocs.map((doc) => [String(doc._id), doc])),
  };
}

function printPlan(plan: ContentIdentityBackfillPlan): void {
  const targetAssignments = plan.assignments.filter(
    (assignment) => assignment.collection === "pan_sync_targets"
  ).length;
  const resourceAssignments = plan.assignments.length - targetAssignments;
  console.log(
    `审计结果：${plan.alreadyConsistent} 条已一致，` +
    `${plan.newIdentities.length} 个待建身份，${targetAssignments} 条台账待回填，` +
    `${resourceAssignments} 条资源待回填，${plan.conflicts.length} 个冲突`
  );
  for (const conflict of plan.conflicts.slice(0, MAX_PRINTED_CONFLICTS)) {
    console.error(
      `[${conflict.scope}] _id=${conflict.documentId}` +
      `${conflict.doubanId ? ` douban_id=${conflict.doubanId}` : ""}: ${conflict.reason}`
    );
  }
  if (plan.conflicts.length > MAX_PRINTED_CONFLICTS) {
    console.error(`另有 ${plan.conflicts.length - MAX_PRINTED_CONFLICTS} 个冲突未输出`);
  }
}

function assertConflictFree(plan: ContentIdentityBackfillPlan): void {
  if (plan.conflicts.length > 0) {
    throw new Error("发现身份冲突；未执行自动修复，请先人工对账");
  }
}

async function insertPlannedIdentities(
  db: Db,
  plan: ContentIdentityBackfillPlan
): Promise<void> {
  if (plan.newIdentities.length === 0) return;
  const now = new Date().toISOString();
  await db.collection<ContentIdentityDoc>(COLLECTIONS.CONTENT_IDENTITIES).insertMany(
    plan.newIdentities.map((identity) => ({
      content_id: identity.contentId,
      external_refs: [{
        provider_id: DOUBAN_CONTENT_PLUGIN_ID,
        external_id: identity.doubanId,
      }],
      created_at: now,
      updated_at: now,
    })),
    { ordered: true }
  );
}

async function applyAssignments(db: Db, state: LoadedState): Promise<number> {
  const targets = db.collection<PanSyncTargetDoc>(COLLECTIONS.PAN_SYNC_TARGETS);
  const resources = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const targetAssignments = state.plan.assignments.filter(
    (assignment) => assignment.collection === "pan_sync_targets"
  );
  const resourceAssignments = state.plan.assignments.filter(
    (assignment) => assignment.collection === "pan_resources"
  );

  const targetOperations = targetAssignments.map((assignment) => {
    const doc = state.targetDocs.get(assignment.documentId);
    if (!doc?._id) throw new Error(`找不到台账文档 ${assignment.documentId}`);
    return {
      updateOne: {
        filter: {
          _id: doc._id,
          douban_id: assignment.doubanId,
          $or: [
            { content_id: { $exists: false } },
            { content_id: null },
            { content_id: "" },
          ],
        } as unknown as Filter<PanSyncTargetDoc>,
        update: { $set: { content_id: assignment.contentId } },
      },
    };
  });
  const resourceOperations = resourceAssignments.map((assignment) => {
    const doc = state.resourceDocs.get(assignment.documentId);
    if (!doc?._id) throw new Error(`找不到资源文档 ${assignment.documentId}`);
    return {
      updateOne: {
        filter: {
          _id: doc._id,
          douban_id: assignment.doubanId,
          $or: [
            { content_id: { $exists: false } },
            { content_id: null },
            { content_id: "" },
          ],
        } as unknown as Filter<PanResourceDoc>,
        update: { $set: { content_id: assignment.contentId } },
      },
    };
  });

  if (targetOperations.length > 0) {
    const result = await targets.bulkWrite(targetOperations, { ordered: true });
    if (result.matchedCount !== targetOperations.length) {
      throw new Error("台账在回填期间发生变化；已停止后续写入，请重新预览");
    }
  }
  if (resourceOperations.length > 0) {
    const result = await resources.bulkWrite(resourceOperations, { ordered: true });
    if (result.matchedCount !== resourceOperations.length) {
      throw new Error("资源在回填期间发生变化；已停止后续写入，请重新预览");
    }
  }
  return targetOperations.length + resourceOperations.length;
}

async function main() {
  if (apply && !maintenance) {
    throw new Error(
      "--apply 必须同时提供 --maintenance，并先停止应用及所有数据库写入任务"
    );
  }

  // This script never invokes application-wide initialization. Preview only
  // performs collection reads; apply manages the two identity indexes itself.
  const db = await getDatabase({ skipInitialization: true });
  let state = await loadState(db);
  printPlan(state.plan);
  if (state.plan.conflicts.length > 0) {
    if (!apply) {
      process.exitCode = 2;
      return;
    }
    assertConflictFree(state.plan);
  }
  if (!apply) {
    console.log("当前为只读预览。停写并人工确认后，加 --apply --maintenance 执行。");
    return;
  }

  await ensureIdentityUniqueIndexes(db);
  state = await loadState(db);
  assertConflictFree(state.plan);
  await insertPlannedIdentities(db, state.plan);

  state = await loadState(db);
  assertConflictFree(state.plan);
  if (state.plan.newIdentities.length > 0) {
    throw new Error("身份集合在回填期间发生变化；请重新预览后再执行");
  }
  const updated = await applyAssignments(db, state);

  const verified = await loadState(db);
  assertConflictFree(verified.plan);
  if (verified.plan.newIdentities.length > 0 || verified.plan.assignments.length > 0) {
    throw new Error("回填后对账未通过；请保持停写并人工检查");
  }
  console.log(`回填完成并通过对账：${updated} 条记录已写入 content_id`);
}

main()
  .catch((error) => {
    console.error("content_id 回填失败:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
