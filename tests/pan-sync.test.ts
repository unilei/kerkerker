/**
 * 标题匹配函数单元测试（覆盖原 QA 报告 P1-2 错绑案例）
 *
 * 不依赖数据库，纯函数测试。运行：
 *   npx tsx tests/pan-sync.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  titlesLooselyMatch,
  titlesStrictlyMatch,
  normalizeTitleForMatch,
  extractTitleCandidate,
  extractYear,
} from "@/lib/kkpan";

test("titlesLooselyMatch: 归一化等值直接通过", () => {
  assert.equal(titlesLooselyMatch("老九门", "老九门"), true);
  assert.equal(titlesLooselyMatch("我不是药神", "我不是药神"), true);
  assert.equal(
    titlesLooselyMatch("我和我的祖国", "我和我的祖国"),
    true
  );
});

test("titlesLooselyMatch: QA 报告中的错绑案例被全部挡住（P1-2 回归）", () => {
  // 2 字短串被长串包含的误匹配必须返回 false
  assert.equal(titlesLooselyMatch("九门", "老九门"), false);
  assert.equal(titlesLooselyMatch("人鱼", "美人鱼"), false);
  assert.equal(titlesLooselyMatch("悬案", "悬案解码"), false);
});

test("titlesLooselyMatch: 合法的季 / 后缀扩展仍能匹配", () => {
  // 双向子串 + 长度比例达标
  assert.equal(titlesLooselyMatch("老九门", "老九门 第一季"), true);
  assert.equal(titlesLooselyMatch("流浪地球", "流浪地球2"), true);
  assert.equal(titlesLooselyMatch("我和我的祖国", "我和我的祖国 电影版"), true);
});

test("titlesLooselyMatch: 较短串不足 3 字时不命中（除归一化等值外）", () => {
  // 2 字片名的扩展形态收紧后不命中——这是为了挡住误绑可接受的代价；
  // 这类场景应依赖豆瓣搜索候选首项或精确归一化等值命中。
  assert.equal(titlesLooselyMatch("悬崖", "悬崖之上"), false);
});

test("titlesLooselyMatch: 一方明显是另一方片段时不命中", () => {
  // 例：长串包含短串但短串仅占长串很小一部分
  assert.equal(titlesLooselyMatch("药神", "我不是药神"), false);
  assert.equal(titlesLooselyMatch("地球", "流浪地球之晨曦救赎剧场版"), false);
});

test("titlesLooselyMatch: 空串或仅符号不命中", () => {
  assert.equal(titlesLooselyMatch("", "任何标题"), false);
  assert.equal(titlesLooselyMatch("《》", "标题"), false);
  // 两边归一化后都是空串，函数把空串视为无效输入，返回 false（而非"等值"）
  assert.equal(titlesLooselyMatch("---", "---"), false);
});

test("titlesStrictlyMatch: 行为与收紧后的宽松匹配一致", () => {
  assert.equal(titlesStrictlyMatch("老九门", "老九门 第一季"), true);
  assert.equal(titlesStrictlyMatch("九门", "老九门"), false);
  assert.equal(titlesStrictlyMatch("悬案", "悬案解码"), false);
  assert.equal(titlesStrictlyMatch("美人鱼", "美人鱼"), true);
});

test("normalizeTitleForMatch: 剥离装饰符号与空白", () => {
  assert.equal(normalizeTitleForMatch("《老九门》 第一季"), "老九门第一季");
  assert.equal(normalizeTitleForMatch("流浪地球 2"), "流浪地球2");
  assert.equal(normalizeTitleForMatch("Title-With:Punctuation!"), "titlewithpunctuation");
});

test("extractYear: 从资源名提取 4 位年份", () => {
  assert.equal(extractYear("老九门 第一季（2016）4K"), "2016");
  assert.equal(extractYear("[2021] 我和我的父辈"), "2021");
  assert.equal(extractYear("无名资源 1080P"), undefined);
});

test("extractTitleCandidate: 从装饰名提取片名候选", () => {
  // 基本截断行为：在元数据标记处停止
  const candidate = extractTitleCandidate("✅━━老九门 第一季（2016）4K 内封中字━━✅");
  assert.ok(
    candidate.includes("老九门"),
    `期望候选包含"老九门"，实际：${candidate}`
  );
});

test("extractTitleCandidate: 跳过线上常见的前置集数与状态括号", () => {
  const samples: Array<[string, string]> = [
    ["🚩🚩🚩 【全 29 集】「炽夏」【国剧 2026】【剧情 爱情】【4K】", "炽夏"],
    ["🚩🚩🚩 【全20集】【星月征途 (2026)】【4K高码】【国语中字】", "星月征途"],
    ["🚩🚩🚩 【已完结】【全10集】【幻世 (2026)】【4K/超清】", "幻世"],
    ["✅━━━━━【S01-S22季全集】【未删减】【恶搞之家】【1080P】", "恶搞之家"],
    ["🚩🚩 【全两季】《问心》1-2季【4K高码】", "问心"],
    ["🚩🚩🚩 【系列全收集】 【暗杀教室（全 2 季+剧场版）】【1080P】", "暗杀教室"],
    ["爱情公寓系列 1-5 季全集 4K 2160P 无水印", "爱情公寓系列"],
  ];

  for (const [fileName, expected] of samples) {
    assert.equal(extractTitleCandidate(fileName), expected, fileName);
  }
});

test("extractTitleCandidate: 优先显式片名而不是描述性标签", () => {
  assert.equal(
    extractTitleCandidate(
      "《学习资料》经典儿童动画故事《小马宝莉1-9季》中英文版 [夸克网盘]"
    ),
    "小马宝莉1-9季"
  );
  assert.equal(
    extractTitleCandidate("【电视剧】杉杉来了 Boss & Me 蓝光高清/完整版/1080P"),
    "杉杉来了 Boss & Me"
  );
});

test("补库匹配：先剥离年份、集数和规格后缀", () => {
  const samples: Array<[string, string]> = [
    ["【老九门(2016)】【48集全】【4K】【夸克网盘】", "老九门"],
    ["🌈 九门 (2026)［全 30 集］［4K 超高清］", "九门"],
    ["✅《人鱼（2026）》【超前完结 22 集】【4K.SDR】", "人鱼"],
    ["警察荣誉 (2022) 4K WEB-DL H265 AAC 2.0", "警察荣誉"],
  ];

  for (const [fileName, title] of samples) {
    const candidate = extractTitleCandidate(fileName);
    assert.equal(
      candidate,
      title,
      `${fileName} 应提取为 ${title}，实际候选：${candidate}`
    );
    assert.equal(
      titlesStrictlyMatch(candidate, title),
      true,
      `${fileName} 应提取为可匹配片名，实际候选：${candidate}`
    );
  }
});

test("补库匹配：提取候选后仍拦截短标题误绑", () => {
  const samples: Array<[string, string]> = [
    ["🌈 九门 (2026)［全 30 集］［4K］", "老九门"],
    ["✅《人鱼（2026）》【4K.SDR】", "美人鱼"],
    ["【悬案】【2025】【4K】", "悬案解码"],
  ];

  for (const [fileName, title] of samples) {
    assert.equal(
      titlesStrictlyMatch(extractTitleCandidate(fileName), title),
      false,
      `${fileName} 不应匹配 ${title}`
    );
  }
});
