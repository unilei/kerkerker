/**
 * 短剧抓取与流水线单元测试（无外部网络，全部用内置 fixture）
 *
 * 运行：npx tsx tests/short-drama.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  extractArticleIds,
  extractMaxPageNumber,
  parseDetailPage,
  parseTagGroups,
  parseDramaTitle,
} from "@/lib/short-drama/duanjugou";
import {
  encryptCredential,
  decryptCredential,
  maskCredential,
  normalizeQuarkCookie,
} from "@/lib/security/credential-crypto";
import { CredentialCryptoError } from "@/lib/security/credential-crypto";

// ---------------------------------------------------------------------------
// 标题解析
// ---------------------------------------------------------------------------

test("parseDramaTitle：全角括号+空格+AI短剧后缀", () => {
  const parsed = parseDramaTitle("曲曲爆火，百万粉丝却求我别写了（98 集）AI短剧");
  assert.equal(parsed.title, "曲曲爆火，百万粉丝却求我别写了");
  assert.equal(parsed.episode_count, 98);
});

test("parseDramaTitle：半角括号无空格", () => {
  const parsed = parseDramaTitle("请旨和离，转身嫁给战神王爷(91集)");
  assert.equal(parsed.title, "请旨和离，转身嫁给战神王爷");
  assert.equal(parsed.episode_count, 91);
});

test("parseDramaTitle：3D版+季数标题", () => {
  const parsed = parseDramaTitle("镇国驸马爷3D版第五季（252集）");
  assert.equal(parsed.title, "镇国驸马爷3D版第五季");
  assert.equal(parsed.episode_count, 252);
});

test("parseDramaTitle：无集数保持原样", () => {
  const parsed = parseDramaTitle("凤凰于飞");
  assert.equal(parsed.title, "凤凰于飞");
  assert.equal(parsed.episode_count, undefined);
});

test("parseDramaTitle：仅剥第一次集数括号，不吞剧名内括号", () => {
  const parsed = parseDramaTitle("夫妻的世界（未删减版）（40集）");
  assert.equal(parsed.title, "夫妻的世界（未删减版）");
  assert.equal(parsed.episode_count, 40);
});

// ---------------------------------------------------------------------------
// 列表页解析（真实结构 fixture）
// ---------------------------------------------------------------------------

const LIST_HTML = `
<div>
<article class="post-item-row">
    <span class="post-cate-badge" style="background-color: #2c3e50">
        <a href="https://duanjugou.top/category-1.html" style="color: white !important;">短剧</a>
    </span>
    <h2 class="post-title">
        <a href="https://duanjugou.top/81864.html" title="曲曲爆火，百万粉丝却求我别写了（98 集）AI短剧">曲曲爆火，百万粉丝却求我别写了（98 集）AI短剧</a>
    </h2>
    <span class="post-date today">08-31</span></article>
<article class="post-item-row">
    <span class="post-cate-badge"><a href="https://duanjugou.top/category-1.html">短剧</a></span>
    <h2 class="post-title">
        <a href="https://duanjugou.top/81667.html" title="请旨和离，转身嫁给<strong>战神</strong>王爷（91集）">请旨和离，转身嫁给<strong>战神</strong>王爷（91集）</a>
    </h2>
    <span class="post-date">08-30</span></article>
</div>
<a href="https://duanjugou.top/page_2323.html">2323</a>
`;

test("extractArticleIds：提取文章ID+去HTML标签标题+去重保序", () => {
  const items = extractArticleIds(LIST_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0].article_id, "81864");
  assert.equal(items[0].title, "曲曲爆火，百万粉丝却求我别写了（98 集）AI短剧");
  assert.equal(items[1].article_id, "81667");
  assert.equal(items[1].title, "请旨和离，转身嫁给战神王爷（91集）");
});

test("extractMaxPageNumber：取分页锚点最大值", () => {
  assert.equal(extractMaxPageNumber(LIST_HTML), 2323);
});

// ---------------------------------------------------------------------------
// 详情页解析
// ---------------------------------------------------------------------------

const DETAIL_HTML = `
<html><head><title>短剧狗</title>
<script type="application/ld+json">
{ "@context": "https://schema.org", "@type": "Article",
  "headline": "曲曲爆火，百万粉丝却求我别写了（98 集）AI短剧",
  "url": "https://duanjugou.top/81864.html",
  "datePublished": "2026-08-31T09:45:12+08:00" }
</script></head>
<body>
<article class="post-detail">
<header class="post-header"><h1 class="post-title">曲曲爆火，百万粉丝却求我别写了（98 集）AI短剧</h1></header>
<div class="post-content"></div>
<div class="pan-links-list">
  <a href="https://pan.quark.cn/s/01939cc98bca" target="_blank" class="pan-link-item">
    <span class="pan-name">夸克网盘</span>
  </a>
</div>
</article>
</body></html>
`;

test("parseDetailPage：标题/日期/夸克链接", () => {
  const detail = parseDetailPage(DETAIL_HTML, "81864");
  assert.ok(detail);
  assert.equal(detail!.article_id, "81864");
  assert.equal(detail!.title, "曲曲爆火，百万粉丝却求我别写了（98 集）AI短剧");
  assert.equal(detail!.publish_date, "2026-08-31");
  assert.equal(detail!.pan_links.length, 1);
  assert.equal(detail!.pan_links[0].url, "https://pan.quark.cn/s/01939cc98bca");
  assert.equal(detail!.pan_links[0].brand, "夸克网盘");
});

test("parseDetailPage：无标题返回 null", () => {
  assert.equal(parseDetailPage("<html><body></body></html>", "1"), null);
});

// ---------------------------------------------------------------------------
// 标签云解析
// ---------------------------------------------------------------------------

const TAGS_HTML = `
<div class="quick-tags-section">
<div class="tag-group"><span class="tag-category">女性标签：</span>
<a href="https://duanjugou.top/search.php?q=%E5%A8%87%E5%A6%BB" class="tag-item" style="background:#fff5f5;color:#ff4d4f;">娇妻</a>
<a href="https://duanjugou.top/search.php?q=%E9%98%BF%E5%A7%A8" class="tag-item" style="background:#f0f5ff;color:#1890ff;">阿姨</a>
</div>
<div class="tag-group"><span class="tag-category">男性标签：</span>
<a href="https://duanjugou.top/search.php?q=%E6%88%98%E7%A5%9E" class="tag-item" style="background:#f0f5ff;color:#1890ff;">战神</a>
</div>
</div>
`;

test("parseTagGroups：分组与标签名", () => {
  const groups = parseTagGroups(TAGS_HTML).groups;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].category, "女性标签");
  assert.deepEqual(groups[0].tags, ["娇妻", "阿姨"]);
  assert.deepEqual(groups[1].tags, ["战神"]);
});

// ---------------------------------------------------------------------------
// 凭证加密
// ---------------------------------------------------------------------------

test("credential-crypto：加解密往返 + 密钥隔离 + 掩码", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "test-key-short-drama";
  const plaintext = "kps=abc123; sign=def456; __pus=xyz789; __puus=tuv000";
  const encrypted = encryptCredential(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.equal(decryptCredential(encrypted), plaintext);

  // 不同密钥解密必须失败
  process.env.CREDENTIAL_ENCRYPTION_KEY = "another-key";
  assert.throws(() => decryptCredential(encrypted), CredentialCryptoError);

  process.env.CREDENTIAL_ENCRYPTION_KEY = "test-key-short-drama";
  assert.equal(maskCredential(plaintext), "kps=ab…tuv000");
  assert.equal(maskCredential("short"), "******");
});

test("normalizeQuarkCookie：无登录态字段报错，新旧 schema 均规整通过", () => {
  assert.throws(
    () => normalizeQuarkCookie("foo=bar; baz=qux"),
    CredentialCryptoError
  );
  // 旧 schema（kps/sign）
  assert.equal(
    normalizeQuarkCookie("kps=abc; __pus=def;\nsign=ghi; extra=1"),
    "kps=abc; __pus=def; sign=ghi; extra=1"
  );
  // 2026-09 实测新 schema（__kps/__kp/__pus/__puus，无 kps/sign）
  assert.equal(
    normalizeQuarkCookie("__uid=u1; __kps=k1; __pus=p1; __kp=kp1; __puus=pu1"),
    "__uid=u1; __kps=k1; __pus=p1; __kp=kp1; __puus=pu1"
  );
});
