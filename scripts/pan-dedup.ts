/**
 * 一次性维护脚本：清理 pan_resources 集合中重复的 kkpan_id 文档。
 *
 * 背景：升级到部分唯一索引（kkpan_id 上 unique + partialFilterExpression）之前，
 * 若历史数据中同一 kkpan_id 已存在多条文档，索引创建会失败。本脚本在启用索引
 * 前运行：按 kkpan_id 聚合，保留 updated_at 最新的一条，其余删除。
 *
 * 运行：
 *   cd kerkerker && npx tsx scripts/pan-dedup.ts
 *
 * 仅处理 source === "kkpan" 且带 kkpan_id 的文档；手工录入不受影响。
 */

import "dotenv/config";
import { getDatabase, closeDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import type { PanResourceDoc } from "@/lib/pan-resources-db";

async function main() {
  const db = await getDatabase();
  const collection = db.collection<PanResourceDoc>(COLLECTIONS.PAN_RESOURCES);

  // 聚合：按 kkpan_id 分组，统计每组数量
  const duplicates = await collection
    .aggregate<{
      _id: number;
      count: number;
      docs: PanResourceDoc[];
    }>([
      {
        $match: {
          source: "kkpan",
          kkpan_id: { $exists: true, $ne: null },
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
    console.log("✅ 未发现重复 kkpan_id，无需清理。");
    await closeDatabase();
    return;
  }

  console.log(`发现 ${duplicates.length} 个重复 kkpan_id，开始清理…`);

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

  console.log(`\n✅ 清理完成，共删除 ${totalDeleted} 条重复文档。`);
  await closeDatabase();
}

main().catch((err) => {
  console.error("❌ 清理失败：", err);
  process.exit(1);
});
