/**
 * Read-only identity and legacy-field audit.
 *
 * This command never creates indexes, writes records, or generates content IDs.
 * It exits with code 2 when contradictions require manual review, and with 0
 * when the graph is consistent (pending content_id backfills are reported).
 *
 *   npx tsx scripts/content-identity-audit.ts
 *   npx tsx scripts/content-identity-audit.ts --json
 */

import "dotenv/config";
import { closeDatabase } from "@/lib/db";
import {
  type ContentIdentityAuditReport,
} from "@/lib/content-identity-audit";
import { loadContentIdentityAuditReport } from "@/lib/content-identity-audit-db";

const jsonOutput = process.argv.includes("--json");
const MAX_PRINTED_ISSUES = 100;

function printHumanReport(report: ContentIdentityAuditReport): void {
  const resources = report.collections.pan_resources;
  const targets = report.collections.pan_sync_targets;
  console.log("内容身份只读审计");
  console.log(
    `身份：${report.identities.total} 条，合法 ${report.identities.valid} 条，` +
      `重复 content_id ${report.identities.duplicateContentIds}，` +
      `重复外部引用 ${report.identities.duplicateExternalRefs}，` +
      `孤儿 ${report.identities.orphanIdentities}`
  );
  console.log(
    `资源：${resources.total} 条，content_id 缺失 ${resources.contentIdMissing}，` +
      `待回填 ${resources.contentIdPendingBackfill}，一致 ${resources.contentIdConsistent}，` +
      `冲突 ${resources.contentIdConflict}，来源双键重复 ${resources.duplicateProviderPairs}`
  );
  console.log(
    `台账：${targets.total} 条，content_id 缺失 ${targets.contentIdMissing}，` +
      `待回填 ${targets.contentIdPendingBackfill}，一致 ${targets.contentIdConsistent}，` +
      `冲突 ${targets.contentIdConflict}，来源双键重复 ${targets.duplicateProviderPairs}`
  );
  console.log(
    `旧 douban_id 关联 ${report.oldDoubanLinkCount} 条，待回填 ${report.pendingBackfill} 条，` +
      `阻断冲突 ${report.blockingConflictCount} 个`
  );
  for (const item of report.issues.slice(0, MAX_PRINTED_ISSUES)) {
    console.error(
      `[${item.code}] ${item.collection} _id=${item.documentId}: ${item.message}` +
        `${item.contentId ? ` content_id=${item.contentId}` : ""}` +
        `${item.doubanId ? ` douban_id=${item.doubanId}` : ""}`
    );
  }
  if (report.issues.length > MAX_PRINTED_ISSUES) {
    console.error(`另有 ${report.issues.length - MAX_PRINTED_ISSUES} 个冲突未输出`);
  }
}

async function main(): Promise<void> {
  const report = await loadContentIdentityAuditReport();
  if (jsonOutput) {
    console.log(JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2));
  } else {
    printHumanReport(report);
  }
  if (report.blockingConflictCount > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error("内容身份审计失败:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
