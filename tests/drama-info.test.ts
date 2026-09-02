/**
 * 详情信息解析单元测试（metadata.json 优先 + 简介.txt 行式结构兜底）
 *
 * 运行：npx tsx tests/drama-info.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseDramaInfo } from "@/lib/short-drama/drama-info";
import { parseDetailPage } from "@/lib/short-drama/duanjugou";

// ---------------------------------------------------------------------------
// parseDramaInfo：metadata.json 结构化数据
// ---------------------------------------------------------------------------

test("parseDramaInfo：metadata 对象字段映射（含中文键）", () => {
  const info = parseDramaInfo(
    {
      名称: "她契约的都是星际大佬",
      作者: "北京阅朋文化科技有限公司",
      分类: "玄幻脑洞",
      集数: 141,
      时长: "129.38分钟 秒",
      简介: "世人都误以为S级魅力召唤师叶星黎徒有颜值……",
      演员信息: [{ 演员: "张三", 饰演: "叶星黎", 演员简介: "青年演员" }],
    },
    undefined
  );
  assert.deepEqual(
    info.fields.map((field) => [field.label, field.value]),
    [
      ["作者", "北京阅朋文化科技有限公司"],
      ["分类", "玄幻脑洞"],
      ["时长", "129.38 分钟"],
    ]
  );
  assert.equal(info.episodeCount, 141);
  assert.equal(info.description, "世人都误以为S级魅力召唤师叶星黎徒有颜值……");
  assert.equal(info.actors.length, 1);
  assert.equal(info.actors[0].name, "张三");
  assert.equal(info.actors[0].role, "叶星黎");
});

test("parseDramaInfo：英文键与演员字符串数组", () => {
  const info = parseDramaInfo(
    {
      title: "Test Drama",
      author: "Studio X",
      genre: "Sci-Fi",
      duration: "96分钟",
      description: "A story.",
      cast: ["Alice", "Bob"],
    },
    undefined
  );
  assert.deepEqual(
    info.fields.map((field) => field.value),
    ["Studio X", "Sci-Fi", "96 分钟"]
  );
  assert.deepEqual(info.actors, [{ name: "Alice" }, { name: "Bob" }]);
});

// ---------------------------------------------------------------------------
// parseDramaInfo：简介.txt 行式结构兜底（源站实测格式，含空演员段）
// ---------------------------------------------------------------------------

const INTRO_SAMPLE = `视频信息记录

名称：她契约的都是星际大佬
作者：北京阅朋文化科技有限公司
分类：玄幻脑洞
集数：141
时长：129.38分钟 秒

简介：
世人都误以为S级魅力召唤师叶星黎徒有颜值，天赋不足、无法缔结异兽，
致使她被战队劝退。身陷低谷的她倾尽所有，激活古老召唤阵法。

后续她接连收服烈焰雄狮等强力异兽，直至神秘族群现身。

演员信息：
演员：
饰演：
演员简介：`;

test("parseDramaInfo：简介文本解析字段/正文，空演员段不产出", () => {
  const info = parseDramaInfo(undefined, INTRO_SAMPLE);
  assert.deepEqual(
    info.fields.map((field) => [field.label, field.value]),
    [
      ["作者", "北京阅朋文化科技有限公司"],
      ["分类", "玄幻脑洞"],
      ["时长", "129.38 分钟"],
    ]
  );
  assert.equal(info.episodeCount, 141);
  assert.ok(info.description?.startsWith("世人都误以为S级魅力召唤师叶星黎徒有颜值"));
  assert.ok(info.description?.includes("后续她接连收服烈焰雄狮等强力异兽"));
  assert.deepEqual(info.actors, []);
});

test("parseDramaInfo：演员三元组配对（有内容时）", () => {
  const intro = `名称：测试剧

简介：
正文一段。

演员信息：
演员：李四
饰演：王五
演员简介：配角出演
演员：赵六
饰演：
演员简介：`;
  const info = parseDramaInfo(undefined, intro);
  assert.equal(info.actors.length, 2);
  assert.deepEqual(info.actors[0], { name: "李四", role: "王五", bio: "配角出演" });
  assert.deepEqual(info.actors[1], { name: "赵六" });
});

test("parseDramaInfo：metadata 优先，缺字段时简介文本补齐", () => {
  const info = parseDramaInfo(
    { 简介: "来自 metadata 的简介" },
    "作者：兜底作者\n分类：兜底分类\n\n简介：\n来自简介文本的正文"
  );
  assert.equal(info.description, "来自 metadata 的简介");
  assert.deepEqual(
    info.fields.map((field) => [field.label, field.value]),
    [
      ["作者", "兜底作者"],
      ["分类", "兜底分类"],
    ]
  );
});

test("parseDramaInfo：无任何数据返回空结构", () => {
  const info = parseDramaInfo(null, undefined);
  assert.deepEqual(info, { fields: [], actors: [] });
});

// ---------------------------------------------------------------------------
// parseDetailPage：发布日期多源提取
// ---------------------------------------------------------------------------

test("parseDetailPage：发布日期优先 datePublished，容忍 ISO 时区后缀", () => {
  const html = `<html><script type="application/ld+json">
    {"datePublished":"2026-09-01T10:18:15+08:00","dateModified":"2026-09-01T11:00:00+08:00"}
  </script><h1 class="post-title">《测试剧》（98集）</h1></html>`;
  const detail = parseDetailPage(html, "82062");
  assert.ok(detail);
  assert.equal(detail.publish_date, "2026-09-01");
});

test("parseDetailPage：无 JSON-LD 时退回页面可见日期", () => {
  const html = `<html><h1 class="post-title">《测试剧》</h1>
    <span class="post-date">发布于 2026-08-15</span></html>`;
  const detail = parseDetailPage(html, "82063");
  assert.ok(detail);
  assert.equal(detail.publish_date, "2026-08-15");
});

test("parseDetailPage：完全无日期时 publish_date 缺省", () => {
  const html = `<html><h1 class="post-title">《测试剧》</h1></html>`;
  const detail = parseDetailPage(html, "82064");
  assert.ok(detail);
  assert.equal(detail.publish_date, undefined);
});

console.log("drama-info tests done");
