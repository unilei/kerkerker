/**
 * pan_resources 来源身份与唯一索引迁移。
 *
 * 默认只读审计。写入前必须停止所有应用实例和同步任务，并显式传入：
 *
 *   npx tsx scripts/pan-dedup.ts --apply --maintenance
 *
 * 可安全合并的重复记录会先完整备份到 pan_resource_dedup_backups。任何
 * 跨影片、跨 content_id 或来源引用冲突都会中止，交由管理员人工处理。
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  type Filter,
  type IndexDescriptionInfo,
  ObjectId,
} from "mongodb";
import { closeDatabase, getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import type { PanResourceDoc } from "@/lib/pan-resources-db";
import {
  canAutoMergeKkpanGroup,
  resolveKkpanIdentity,
  sortKkpanGroupForRetention,
  validProviderPair,
} from "@/lib/pan/dedup-policy";

const apply = process.argv.includes("--apply");
const maintenance = process.argv.includes("--maintenance");

interface BackupDoc {
  run_id: string;
  original_id: ObjectId;
  resource: PanResourceDoc;
  reasons: string[];
  backed_up_at: string;
}

interface MigrationRunDoc {
  _id: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string;
  failed_at?: string;
  error?: string;
  planned_mutations: number;
  planned_deletions: number;
  backup_run_id: string;
  original_source_indexes: Array<{
    name?: string;
    key: IndexDescriptionInfo["key"];
    unique?: boolean;
    sparse?: boolean;
    hidden?: boolean;
    partialFilterExpression?: IndexDescriptionInfo["partialFilterExpression"];
    collation?: IndexDescriptionInfo["collation"];
  }>;
}

interface PlannedMutation {
  doc: PanResourceDoc & { _id: ObjectId };
  set: Partial<
    Pick<PanResourceDoc, "source" | "provider_id" | "provider_resource_id" | "kkpan_id">
  >;
  unset: Partial<Record<"kkpan_id" | "provider_id" | "provider_resource_id", "">>;
  reasons: string[];
}

interface Conflict {
  kind: string;
  documentIds: string[];
  detail: string;
}

function hasOwn(doc: PanResourceDoc, key: keyof PanResourceDoc): boolean {
  return Object.prototype.hasOwnProperty.call(doc, key);
}

function keysOf(index: IndexDescriptionInfo): string[] {
  return Object.keys(index.key || {});
}

function isDesiredKkpanIndex(index: IndexDescriptionInfo): boolean {
  const partial = index.partialFilterExpression as
    | Record<string, Record<string, unknown>>
    | undefined;
  return (
    index.unique === true &&
    keysOf(index).length === 1 &&
    index.key?.kkpan_id === 1 &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation == null &&
    partial != null &&
    Object.keys(partial).length === 1 &&
    partial.kkpan_id?.$type === "number" &&
    Object.keys(partial.kkpan_id).length === 1
  );
}

function isProviderPairIndex(index: IndexDescriptionInfo): boolean {
  const keys = keysOf(index);
  return (
    keys.length === 2 &&
    keys.includes("provider_id") &&
    keys.includes("provider_resource_id")
  );
}

function isDesiredProviderIndex(index: IndexDescriptionInfo): boolean {
  const partial = index.partialFilterExpression as
    | Record<string, Record<string, unknown>>
    | undefined;
  return (
    index.unique === true &&
    isProviderPairIndex(index) &&
    keysOf(index)[0] === "provider_id" &&
    keysOf(index)[1] === "provider_resource_id" &&
    index.key?.provider_id === 1 &&
    index.key?.provider_resource_id === 1 &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.collation == null &&
    partial != null &&
    Object.keys(partial).length === 2 &&
    partial.provider_id?.$type === "string" &&
    Object.keys(partial.provider_id).length === 1 &&
    partial.provider_resource_id?.$type === "string" &&
    Object.keys(partial.provider_resource_id).length === 1
  );
}

function snapshotFilter(
  doc: PanResourceDoc & { _id: ObjectId }
): Filter<PanResourceDoc> {
  const conditions: Array<Record<string, unknown>> = [{ _id: doc._id }];
  for (const field of [
    "updated_at",
    "douban_id",
    "content_id",
    "internal_id",
    "source",
    "kkpan_id",
    "provider_id",
    "provider_resource_id",
  ] as const) {
    conditions.push(
      hasOwn(doc, field)
        ? { [field]: doc[field] }
        : { [field]: { $exists: false } }
    );
  }
  return { $and: conditions } as Filter<PanResourceDoc>;
}

function addConflict(
  conflicts: Conflict[],
  kind: string,
  docs: readonly PanResourceDoc[],
  detail: string
): void {
  conflicts.push({
    kind,
    documentIds: docs.map((doc) => String(doc._id)),
    detail,
  });
}

function addReason(mutation: PlannedMutation, reason: string): void {
  if (!mutation.reasons.includes(reason)) mutation.reasons.push(reason);
}

async function main() {
  if (apply && !maintenance) {
    throw new Error(
      "写入模式还需要 --maintenance；请先停止全部应用实例和同步任务"
    );
  }

  // 迁移必须绕过应用启动索引初始化，否则旧索引或重复数据会先使连接失败。
  const db = await getDatabase({ skipInitialization: true });
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);
  const allDocuments = await collection.find({}).toArray();
  const unsupportedIds = allDocuments.filter((doc) => !(doc._id instanceof ObjectId));
  if (unsupportedIds.length > 0) {
    throw new Error(
      `发现 ${unsupportedIds.length} 条非 ObjectId 资源，拒绝在未人工对账时迁移`
    );
  }
  const documents = allDocuments as Array<PanResourceDoc & { _id: ObjectId }>;
  const conflicts: Conflict[] = [];
  const mutations = new Map<string, PlannedMutation>();
  const validKkpanGroups = new Map<number, Array<PanResourceDoc & { _id: ObjectId }>>();

  const mutationFor = (doc: PanResourceDoc & { _id: ObjectId }): PlannedMutation => {
    const key = doc._id.toHexString();
    const current = mutations.get(key);
    if (current) return current;
    const created: PlannedMutation = { doc, set: {}, unset: {}, reasons: [] };
    mutations.set(key, created);
    return created;
  };

  for (const doc of documents) {
    const rawKkpanId = doc.kkpan_id as unknown;
    const hasKkpanField = hasOwn(doc, "kkpan_id");
    const hasProviderFields = hasOwn(doc, "provider_id") || hasOwn(doc, "provider_resource_id");
    const identity = resolveKkpanIdentity(doc);
    if (identity.kind === "conflict") {
      addConflict(
        conflicts,
        "kkpan-identity-conflict",
        [doc],
        identity.reason
      );
      continue;
    }

    if (identity.kind === "kkpan") {
      const effectiveKkpanId = identity.kkpanId;
      const pair = identity.pair;
      const group = validKkpanGroups.get(effectiveKkpanId) || [];
      group.push(doc);
      validKkpanGroups.set(effectiveKkpanId, group);

      const expectedResourceId = String(effectiveKkpanId);
      const mutation = mutationFor(doc);
      if (rawKkpanId !== effectiveKkpanId) {
        mutation.set.kkpan_id = effectiveKkpanId;
        delete mutation.unset.kkpan_id;
        addReason(mutation, "从统一来源引用恢复 kkpan_id");
      }
      if (!pair) {
        mutation.set.provider_id = KKPAN_PLUGIN_ID;
        mutation.set.provider_resource_id = expectedResourceId;
        addReason(mutation, "补齐 KKPAN 统一来源引用");
      }
      if (doc.source !== "kkpan") {
        mutation.set.source = "kkpan";
        addReason(mutation, "修正 KKPAN 来源标记");
      }
      continue;
    }

    if (hasKkpanField) {
      const mutation = mutationFor(doc);
      mutation.unset.kkpan_id = "";
      addReason(mutation, "移除 null 或无效 kkpan_id");
    }

    if (!identity.pair && hasProviderFields) {
      const mutation = mutationFor(doc);
      mutation.unset.provider_id = "";
      mutation.unset.provider_resource_id = "";
      addReason(mutation, "移除空来源引用字段");
    }
  }

  const dropIds = new Set<string>();
  const dropDocs: Array<PanResourceDoc & { _id: ObjectId }> = [];
  for (const [kkpanId, group] of validKkpanGroups) {
    if (group.length < 2) continue;
    if (!canAutoMergeKkpanGroup(group)) {
      addConflict(
        conflicts,
        "cross-content-duplicate",
        group,
        `kkpan_id=${kkpanId} 没有共同且无冲突的有效影片身份锚点`
      );
      continue;
    }
    const sorted = sortKkpanGroupForRetention(group) as Array<
      PanResourceDoc & { _id: ObjectId }
    >;
    for (const doc of sorted.slice(1)) {
      dropIds.add(doc._id.toHexString());
      dropDocs.push(doc);
      mutations.delete(doc._id.toHexString());
    }
  }

  const projectedProviderGroups = new Map<string, Array<PanResourceDoc & { _id: ObjectId }>>();
  for (const doc of documents) {
    if (dropIds.has(doc._id.toHexString())) continue;
    const mutation = mutations.get(doc._id.toHexString());
    const providerId = mutation?.unset.provider_id === ""
      ? undefined
      : mutation?.set.provider_id ?? doc.provider_id;
    const providerResourceId = mutation?.unset.provider_resource_id === ""
      ? undefined
      : mutation?.set.provider_resource_id ?? doc.provider_resource_id;
    const pair = validProviderPair(providerId, providerResourceId);
    if (!pair) continue;
    const key = `${pair.providerId}\u0000${pair.providerResourceId}`;
    const group = projectedProviderGroups.get(key) || [];
    group.push(doc);
    projectedProviderGroups.set(key, group);
  }
  for (const [pair, group] of projectedProviderGroups) {
    if (group.length > 1) {
      addConflict(
        conflicts,
        "duplicate-provider-reference",
        group,
        `来源引用 ${pair.replace("\u0000", ":")} 对应多条保留记录`
      );
    }
  }

  for (const [id, mutation] of [...mutations]) {
    if (mutation.reasons.length === 0) mutations.delete(id);
  }

  console.log(`扫描记录：${documents.length}`);
  console.log(`计划规范化：${mutations.size}`);
  console.log(`计划合并的同影片 KKPAN 重复记录：${dropDocs.length}`);
  console.log(`阻断性冲突：${conflicts.length}`);

  for (const conflict of conflicts) {
    console.error(
      `[${conflict.kind}] ${conflict.detail}; documents=${conflict.documentIds.join(",")}`
    );
  }
  if (conflicts.length > 0) {
    throw new Error("检测到来源身份冲突；未执行任何写入，请先人工对账");
  }

  const collectionExists = await db
    .listCollections({ name: COLLECTIONS.PAN_RESOURCES }, { nameOnly: true })
    .hasNext();
  const indexes = collectionExists ? await collection.listIndexes().toArray() : [];
  const kkpanIndexes = indexes.filter((index) => keysOf(index).length === 1 && keysOf(index)[0] === "kkpan_id");
  const providerIndexes = indexes.filter(isProviderPairIndex);
  const wrongIndexes = [
    ...kkpanIndexes.filter((index) => !isDesiredKkpanIndex(index)),
    ...providerIndexes.filter((index) => !isDesiredProviderIndex(index)),
  ];
  const reservedNameConflicts = indexes.filter(
    (index) =>
      (index.name === "kkpan_id_1" && !kkpanIndexes.includes(index)) ||
      (index.name === "provider_id_1_provider_resource_id_1" &&
        !providerIndexes.includes(index))
  );
  console.log(`待替换的旧来源索引：${wrongIndexes.length}`);
  if (reservedNameConflicts.length > 0) {
    throw new Error(
      `保留索引名被其它键占用：${reservedNameConflicts.map((index) => index.name).join(", ")}`
    );
  }

  if (!apply) {
    console.log(
      "当前为只读预览，数据库未修改。停掉全部写入端后，使用 --apply --maintenance 执行。"
    );
    return;
  }

  const affected = [
    ...[...mutations.values()].map((mutation) => ({
      doc: mutation.doc,
      reasons: mutation.reasons,
    })),
    ...dropDocs.map((doc) => ({ doc, reasons: ["合并同影片的重复 KKPAN 来源记录"] })),
  ];
  const runId = randomUUID();
  const now = new Date().toISOString();
  const runs = db.collection<MigrationRunDoc>(COLLECTIONS.PAN_RESOURCE_DEDUP_RUNS);
  await runs.insertOne({
    _id: runId,
    status: "running",
    started_at: now,
    planned_mutations: mutations.size,
    planned_deletions: dropDocs.length,
    backup_run_id: runId,
    original_source_indexes: [...kkpanIndexes, ...providerIndexes].map((index) => ({
      name: index.name,
      key: index.key,
      unique: index.unique,
      sparse: index.sparse,
      hidden: index.hidden,
      partialFilterExpression: index.partialFilterExpression,
      collation: index.collation,
    })),
  });

  try {
    if (affected.length > 0) {
      const backup = db.collection<BackupDoc>(COLLECTIONS.PAN_RESOURCE_DEDUP_BACKUPS);
      await backup.createIndex({ run_id: 1, original_id: 1 }, { unique: true });
      await backup.insertMany(
        affected.map(({ doc, reasons }) => ({
          run_id: runId,
          original_id: doc._id,
          resource: doc,
          reasons,
          backed_up_at: now,
        })),
        { ordered: true }
      );
      console.log(`迁移前备份完成：${affected.length} 条，run_id=${runId}`);
    }

    // 先删除已备份的 loser，避免 survivor 补齐 provider 引用时撞上现有唯一索引。
    for (const doc of dropDocs) {
      const result = await collection.deleteOne(snapshotFilter(doc));
      if (result.deletedCount !== 1) {
        throw new Error(
          `记录 ${doc._id} 在扫描后发生变化；迁移已中止，备份 run_id=${runId}`
        );
      }
    }

    for (const mutation of mutations.values()) {
      const update: {
        $set?: Partial<PanResourceDoc>;
        $unset?: Record<string, "">;
      } = {};
      if (Object.keys(mutation.set).length > 0) update.$set = mutation.set;
      if (Object.keys(mutation.unset).length > 0) update.$unset = mutation.unset;
      const result = await collection.updateOne(snapshotFilter(mutation.doc), update);
      if (result.matchedCount !== 1) {
        throw new Error(
          `记录 ${mutation.doc._id} 在扫描后发生变化；迁移已中止，备份 run_id=${runId}`
        );
      }
    }

    for (const index of wrongIndexes) {
      if (!index.name) throw new Error("发现无名称的旧索引，无法安全替换");
      await collection.dropIndex(index.name);
    }
    if (!kkpanIndexes.some(isDesiredKkpanIndex)) {
      await collection.createIndex(
        { kkpan_id: 1 },
        {
          unique: true,
          partialFilterExpression: { kkpan_id: { $type: "number" } },
        }
      );
    }
    if (!providerIndexes.some(isDesiredProviderIndex)) {
      await collection.createIndex(
        { provider_id: 1, provider_resource_id: 1 },
        {
          unique: true,
          partialFilterExpression: {
            provider_id: { $type: "string" },
            provider_resource_id: { $type: "string" },
          },
        }
      );
    }

    const finalIndexes = await collection.listIndexes().toArray();
    const finalKkpanIndexes = finalIndexes.filter(
      (index) => keysOf(index).length === 1 && keysOf(index)[0] === "kkpan_id"
    );
    const finalProviderIndexes = finalIndexes.filter(isProviderPairIndex);
    if (
      finalKkpanIndexes.length !== 1 ||
      !isDesiredKkpanIndex(finalKkpanIndexes[0]) ||
      finalProviderIndexes.length !== 1 ||
      !isDesiredProviderIndex(finalProviderIndexes[0])
    ) {
      throw new Error(
        `来源唯一索引最终校验失败；保持维护模式并根据备份 run_id=${runId} 处理`
      );
    }

    await runs.updateOne(
      { _id: runId, status: "running" },
      { $set: { status: "completed", completed_at: new Date().toISOString() } }
    );

    console.log(
      `迁移完成：规范化 ${mutations.size} 条，合并 ${dropDocs.length} 条；备份 run_id=${runId}`
    );
  } catch (error) {
    await runs.updateOne(
      { _id: runId, status: "running" },
      {
        $set: {
          status: "failed",
          failed_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        },
      }
    );
    throw error;
  }
}

main()
  .catch((error) => {
    console.error("pan_resources 迁移失败:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
