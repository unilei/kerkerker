#!/usr/bin/env node
/**
 * 一次性运维脚本：清理旧流水线（duanjugou 抓取→自有夸克转存）遗留的
 * 夸克网盘转存目录 + 本地 short_dramas 旧记录。
 *
 * 切换到 kkpan 数据源后本地库会清空重建（admin「清空短剧库」），
 * 但旧记录里指向「自己网盘已转存目录」的 fid 只剩这里能拿到——
 * 必须在清库之前跑本脚本，否则网盘侧只能手动清理（夸克 UI 全选删除）。
 *
 * 流程：读 short_dramas 中带 own_folder_fid / own_share_url 的旧文档 →
 * 调夸克删除接口清网盘目录 → 删本地记录；网盘删除失败的保留记录可重跑。
 *
 * 用法（在项目根目录）：
 *   npx tsx scripts/purge-legacy-quark-folders.ts --dry-run   # 只统计不删
 *   npx tsx scripts/purge-legacy-quark-folders.ts             # 执行清理
 *   npx tsx scripts/purge-legacy-quark-folders.ts --limit=50  # 每次最多清 50 条
 *
 * 环境变量（自动从项目根 .env 读取）：MONGODB_URI、MONGODB_DB_NAME、
 * CREDENTIAL_ENCRYPTION_KEY（解密 cloud_credentials 里的夸克 cookie）。
 * 防风控：逐条删除，间隔 1.5s；几万条需要数小时，可分多次跑（幂等可续）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { QuarkApiClient } from "@/lib/quark/quark-api-client";
import {
  decryptCredential,
  CredentialCryptoError,
} from "@/lib/security/credential-crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");

for (const line of readFileSync(join(projectRoot, ".env"), "utf8").split("\n")) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].trim();
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) || Infinity : Infinity;
const DELETE_DELAY_MS = 1_500;

if (!process.env.MONGODB_URI) {
  console.error("缺少 MONGODB_URI（.env）");
  process.exit(1);
}
if (!process.env.CREDENTIAL_ENCRYPTION_KEY && !process.env.ADMIN_SESSION_SECRET) {
  console.error("缺少 CREDENTIAL_ENCRYPTION_KEY（解密夸克凭证用）");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "kerkerker");

  const credDoc = await db
    .collection("cloud_credentials")
    .findOne({ platform: "quark" });
  if (!credDoc?.cookie_encrypted) {
    console.error("cloud_credentials 里没有 quark 凭证，无法清理网盘文件");
    process.exit(1);
  }
  let cookie: string;
  try {
    cookie = decryptCredential(credDoc.cookie_encrypted);
  } catch (error) {
    console.error(
      "夸克凭证解密失败（检查 CREDENTIAL_ENCRYPTION_KEY）：",
      error instanceof CredentialCryptoError ? error.message : error
    );
    process.exit(1);
  }
  const quark = new QuarkApiClient({ cookie });

  // 旧 schema 字段（own_folder_fid / own_share_url）只存在于历史文档；
  // 用原始查询读取，不经过类型层
  const legacyFilter = {
    $or: [{ own_folder_fid: { $type: "string" } }, { own_share_url: { $type: "string" } }],
  };
  const total = await db.collection("short_dramas").countDocuments(legacyFilter);
  console.log(`待清理旧记录：${total} 条${dryRun ? "（dry-run，不删除）" : ""}`);
  if (dryRun) {
    await client.close();
    return;
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const cursor = db.collection("short_dramas").find(legacyFilter).limit(limit);
  for await (const doc of cursor) {
    processed += 1;
    const title = String(doc.title ?? doc._id);
    try {
      if (doc.own_folder_fid) {
        await quark.deleteOwnedFilesByFids([doc.own_folder_fid]);
      } else if (doc.own_share_url) {
        await quark.deleteOwnedFilesByShareLink(doc.own_share_url);
      } else {
        continue;
      }
      await db.collection("short_dramas").deleteOne({ _id: doc._id });
      succeeded += 1;
      console.log(`[${processed}] 已清理：${title}`);
    } catch (error) {
      failed += 1;
      console.warn(
        `[${processed}] 清理失败（保留记录可重跑）：${title}:`,
        error instanceof Error ? error.message : error
      );
    }
    await sleep(DELETE_DELAY_MS);
  }

  console.log(`完成：成功 ${succeeded}、失败 ${failed}`);
  await client.close();
}

main().catch((error) => {
  console.error("执行失败:", error);
  process.exit(1);
});
