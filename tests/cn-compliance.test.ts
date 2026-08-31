/**
 * cn-compliance 分支文案与守门测试（short-drama 版）
 *
 * 覆盖：
 *   - 前台不出现"在线播放/立即播放"等播放类文案（合规红线：信息展示 + 网盘导航）
 *   - 影视站旧路由不回归（本分支是纯短剧站）
 *   - 短剧流水线关键约束守门（水位语义 / 转存串行 / 凭证加密 / 失效分类）
 *
 * 运行：npx tsx tests/cn-compliance.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(__dirname, "..");

function readFile(rel: string): string {
  return readFileSync(join(projectRoot, rel), "utf-8");
}

const FORBIDDEN_PLAYBACK_PHRASES = [
  "在线观看",
  "在线播放",
  "立即播放",
  "免费观看",
  "多集连播",
];

test("P1-5: app/layout.tsx 不再出现播放类违规文案", () => {
  const source = readFile("app/layout.tsx");
  for (const phrase of FORBIDDEN_PLAYBACK_PHRASES) {
    assert.ok(!source.includes(phrase), `app/layout.tsx 仍含违规文案：${phrase}`);
  }
});

test("P1-5: 影视站旧路由不再回归", () => {
  for (const legacyPath of [
    "app/browse",
    "app/calendar",
    "app/category",
    "app/movie",
    "app/search",
    "app/api/content",
    "app/api/pan-resources",
    "app/api/kkpan",
    "app/api/plugins",
    "app/api/image-proxy",
    "components/DoubanCard.tsx",
    "components/home/HeroBanner.tsx",
    "components/home/SearchModal.tsx",
    "lib/pan-resources-db.ts",
    "lib/kkpan.ts",
    "lib/douban-service.ts",
    "lib/plugins",
    "lib/pan",
    "instrumentation.ts",
  ]) {
    assert.ok(
      !existsSync(join(projectRoot, legacyPath)),
      `${legacyPath} 应已删除（短剧站不再有影视路由与旧聚合基建）`
    );
  }
});

test("P1-5: 短剧前台组件不出现播放类违规文案", () => {
  for (const rel of [
    "app/page.tsx",
    "app/drama/[id]/page.tsx",
    "components/home/Navbar.tsx",
    "components/home/Footer.tsx",
    "components/short-drama/ShortDramaCard.tsx",
    "components/short-drama/ShortDramaPanSection.tsx",
    "components/short-drama/TagCloud.tsx",
    "components/admin/ShortDramaSourceTab.tsx",
  ]) {
    const source = readFile(rel);
    for (const phrase of FORBIDDEN_PLAYBACK_PHRASES) {
      assert.ok(!source.includes(phrase), `${rel} 仍含违规文案：${phrase}`);
    }
  }
});

test("P1-5: layout metadata 改为信息检索口径", () => {
  const source = readFile("app/layout.tsx");
  assert.ok(
    source.includes("短剧信息"),
    "layout metadata 应包含短剧信息检索口径文案"
  );
});

// ---------------------------------------------------------------------------
// 短剧流水线关键约束守门
// ---------------------------------------------------------------------------

test("守门: 抓取水位只由成功处理条目推进（KKPAN 水位教训）", () => {
  const source = readFile("lib/short-drama/scrape.ts");
  assert.ok(
    source.includes("last_article_watermark"),
    "增量抓取应使用文章 ID 水位（last_article_watermark）"
  );
  assert.ok(
    source.includes("processedIds"),
    "水位只统计成功处理的条目（processedIds），预算中断不推高水位"
  );
  assert.ok(
    source.includes("items_skipped_existing"),
    "回填重跑应跳过已有源链接的条目（items_skipped_existing）"
  );
});

test("守门: 转存串行防风控 + 凭证失效中止整轮", () => {
  const source = readFile("lib/short-drama/transfer.ts");
  assert.ok(
    source.includes("SAVE_DELAY_MS"),
    "转存之间必须有固定间隔（SAVE_DELAY_MS）防风控"
  );
  assert.ok(
    source.includes("QuarkCredentialInvalidError"),
    "凭证失效必须单独分类并中止整轮（QuarkCredentialInvalidError）"
  );
  assert.ok(
    source.includes("markCloudCredentialInvalid"),
    "凭证失效时必须标记凭证（markCloudCredentialInvalid）"
  );
});

test("守门: 夸克凭证失效按 HTTP 401 / 31001 分类", () => {
  const source = readFile("lib/quark/quark-api-client.ts");
  assert.ok(
    source.includes("QuarkCredentialInvalidError"),
    "夸克客户端应抛出 QuarkCredentialInvalidError"
  );
  assert.ok(
    source.includes("31001"),
    "夸克客户端应识别业务码 31001（未登录）"
  );
});

test("守门: 凭证必须 AES-256-GCM 加密落库", () => {
  const source = readFile("lib/cloud-credentials-db.ts");
  assert.ok(
    source.includes("encryptCredential") && source.includes("decryptCredential"),
    "凭证落库必须加密（encryptCredential / decryptCredential）"
  );
  const crypto = readFile("lib/security/credential-crypto.ts");
  assert.ok(
    crypto.includes("aes-256-gcm"),
    "凭证加密算法应为 AES-256-GCM"
  );
});

test("守门: 凭证 API 只回掩码不回明文", () => {
  const source = readFile("app/api/admin/cloud-credentials/route.ts");
  assert.ok(
    !source.includes("cookie: cookie") && !source.includes("cookie: plaintext"),
    "凭证 API 响应不得包含明文 cookie"
  );
  assert.ok(
    source.includes("getCloudCredentialView"),
    "凭证读取必须走脱敏视图（getCloudCredentialView）"
  );
});

test("守门: 短剧前台只展示转存完成且使用自己的分享链接", () => {
  const listRoute = readFile("app/api/short-dramas/route.ts");
  assert.ok(
    listRoute.includes('status: "done"'),
    "公开列表只回转存完成（done）的条目"
  );
  const detailRoute = readFile("app/api/short-dramas/[id]/route.ts");
  assert.ok(
    detailRoute.includes('status !== "done"') &&
      detailRoute.includes("own_share_url"),
    "公开详情必须校验 done 状态并回自己的分享链接（own_share_url）"
  );
  assert.ok(
    !detailRoute.includes("source_share_url"),
    "公开详情不得暴露源站原始链接（source_share_url）"
  );
});
