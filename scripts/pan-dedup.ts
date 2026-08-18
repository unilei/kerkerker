/**
 * 一次性维护脚本：为 pan_resources.kkpan_id 升级到部分唯一索引做准备。
 *
 * 修复三类历史脏数据/旧索引（对应 QA 审查 P1-B）：
 *
 * 1) 重复的数字 kkpan_id：升级前若同一数字 kkpan_id 已有多条文档，
 *    唯一索引会建失败。按 kkpan_id 聚合，保留 updated_at 最新的一条，其余删除。
 *
 * 2) 历史遗留的 kkpan_id: null 文档：旧版本写入 undefined 时被驱动序列化为 null，
 *    手工录入的两条资源都会变成 null。这会与 `$type: "number"` 部分索引配合不理想。
 *    本脚本把这些 null 全部 $unset（移除该字段），让手工资源彻底不带 kkpan_id。
 *
 * 3) 旧的普通索引 `kkpan_id_1`：升级前需 drop 才能重建为带 partialFilterExpression
 *    的唯一索引（MongoDB 不允许同名索引选项冲突）。dropIndex 找不到目标会抛错，吞掉。
 *    清理完数据后立即重建唯一索引，省一次重启。
 *
 * 运行：
 *   cd kerkerker && npx tsx scripts/pan-dedup.ts
 *
 * 之后重启服务，initializeDatabase 会复用此唯一索引（createIndex 同名同选项是幂等的）。
 */

import "dotenv/config";
import { getDatabase, closeDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import type { PanResourceDoc } from "@/lib/pan-resources-db";
import type { Filter } from "mongodb";

async function main() {
  // 迁移脚本必须能在旧普通索引/重复数据存在时启动，跳过应用运行时索引检查。
  const db = await getDatabase({ skipInitialization: true });
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  // ---------- Step 1: 清理 kkpan_id: null ----------
  // 历史 doc 的 kkpan_id 在 DB 里可能是 null（旧版本 undefined→null 序列化），
  // 但 PanResourceDoc 类型只允许 number | undefined，所以用类型断言放宽查询条件。
  const nullUnset = await collection.updateMany(
    { kkpan_id: { $type: 10 } } as unknown as Filter<PanResourceDoc>,
    { $unset: { kkpan_id: "" } }
  );
  console.log(
    `Step 1: 移除 kkpan_id: null 文档字段（手工资源）—— 命中 ${nullUnset.modifiedCount} 条`
  );

  // 新写入只接受正安全整数。先移除历史 0、负数、小数、NaN 和超出 JS 安全范围的值，
  // 避免它们进入失效联动，也保证后面的去重范围与最终 number 部分索引一致。
  const numericDocs = await collection
    .find({ kkpan_id: { $type: "number" } } as unknown as Filter<PanResourceDoc>)
    .toArray();
  const invalidNumericIds = numericDocs
    .filter(
      (doc) =>
        !Number.isSafeInteger(doc.kkpan_id) || (doc.kkpan_id as number) <= 0
    )
    .map((doc) => doc._id)
    .filter((id) => id != null);
  if (invalidNumericIds.length > 0) {
    await collection.updateMany(
      { _id: { $in: invalidNumericIds } },
      { $unset: { kkpan_id: "" } }
    );
  }
  console.log(
    `Step 1: 移除无效数字 kkpan_id 字段 —— 命中 ${invalidNumericIds.length} 条`
  );

  // 历史版本可能已经写入数字 kkpan_id，但 source 仍为空或 manual；数字
  // ID 本身就是同步来源的可靠标记，统一修正后才能参加失效联动。
  const sourceNormalized = await collection.updateMany(
    {
      kkpan_id: { $type: "number" },
      source: { $ne: "kkpan" },
    } as unknown as Filter<PanResourceDoc>,
    { $set: { source: "kkpan" } }
  );
  console.log(
    `Step 1: 修正带数字 kkpan_id 的 source —— 命中 ${sourceNormalized.modifiedCount} 条`
  );

  // ---------- Step 2: 去重数字 kkpan_id ----------
  const duplicates = await collection
    .aggregate<{
      _id: number;
      count: number;
      docs: PanResourceDoc[];
    }>([
      {
        $match: {
          // 与最终 partialFilterExpression 完全一致；无效数字已在 Step 1 移除。
          kkpan_id: { $type: "number" },
        },
      },
      { $sort: { updated_at: -1 } },
      {
        $group: {
          _id: "$kkpan_id",
          count: { $sum: 1 },
          docs: { $push: "$$ROOT" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (duplicates.length === 0) {
    console.log("Step 2: 未发现重复的数字 kkpan_id，无需清理");
  } else {
    console.log(`Step 2: 发现 ${duplicates.length} 个重复 kkpan_id，开始清理…`);
    let totalDeleted = 0;
    for (const group of duplicates) {
      // docs 已按 updated_at 倒序，保留首条（最新），删除其余
      const [keep, ...drop] = group.docs;
      const dropIds = drop.map((d) => d._id).filter((id) => id != null);
      const result = await collection.deleteMany({ _id: { $in: dropIds } });
      totalDeleted += result.deletedCount;
      console.log(
        `  kkpan_id=${group._id}: 保留 ${keep._id} (updated ${keep.updated_at})，删除 ${result.deletedCount} 条`
      );
    }
    console.log(`Step 2 完成：共删除 ${totalDeleted} 条重复文档`);
  }

  // ---------- Step 3: drop 旧索引并重建为部分唯一索引 ----------
  console.log("Step 3: 替换 kkpan_id 索引...");
  const indexes = await collection.listIndexes().toArray();
  const kkpanIndexes = indexes.filter((index) => {
    const keys = Object.keys(index.key || {});
    return keys.length === 1 && keys[0] === "kkpan_id";
  });
  for (const index of kkpanIndexes) {
    const name = index.name;
    if (!name) continue;
    await collection.dropIndex(name);
    console.log(`  dropIndex('${name}') 完成`);
  }
  try {
    await collection.createIndex(
      { kkpan_id: 1 },
      {
        unique: true,
        partialFilterExpression: { kkpan_id: { $type: "number" } },
      }
    );
    console.log("  唯一索引创建完成：{ kkpan_id: 1 } unique + partialFilterExpression($type=number)");
  } catch (err) {
    console.error("  ❌ 唯一索引创建失败：", err);
    console.error(
      "  请人工检查是否仍有重复数字 kkpan_id（理论上 Step 2 已清干净）"
    );
    await closeDatabase();
    process.exit(1);
  }

  console.log("\n✅ 全部清理完成。可重启服务，initializeDatabase 会复用现有唯一索引。");
  await closeDatabase();
}

main().catch((err) => {
  console.error("❌ 清理失败：", err);
  process.exit(1);
});
