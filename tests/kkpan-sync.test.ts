/**
 * kkpan 条目同步解析/聚合单元测试（无外部网络、无数据库依赖）
 *
 * 覆盖：平台标签剥离、集数解析、展示剧名清洗、content_key 归一化、
 * 同剧多行折叠策略。
 *
 * 运行：npx tsx tests/kkpan-sync.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  stripPlatformSuffix,
  stripSerialPrefix,
  extractEpisodeCount,
  stripEpisodeMarkers,
  formatDisplayTitle,
  buildContentKey,
  parseKkpanResourceRow,
  collapseByContentKey,
  type ParsedKkpanResource,
} from "@/lib/short-drama/kkpan-sync";

// ---------------------------------------------------------------------------
// 平台标签 / 集数 / 剧名
// ---------------------------------------------------------------------------

test("stripPlatformSuffix：剥尾部 [夸克网盘] 标签", () => {
  assert.equal(stripPlatformSuffix("凤凰于飞 全80集 [夸克网盘]"), "凤凰于飞 全80集");
  assert.equal(stripPlatformSuffix("凤凰于飞 [Quark]"), "凤凰于飞");
  assert.equal(stripPlatformSuffix("凤凰于飞"), "凤凰于飞");
});

test("stripSerialPrefix：剥源站数字序号前缀，纯数字剧名不受影响", () => {
  assert.equal(stripSerialPrefix("178.微光照亮我的余生"), "微光照亮我的余生");
  assert.equal(stripSerialPrefix("12、凤凰于飞"), "凤凰于飞");
  assert.equal(stripSerialPrefix("2024爱情故事"), "2024爱情故事");
  assert.equal(stripSerialPrefix("凤凰于飞"), "凤凰于飞");
});

test("extractEpisodeCount：更新至/全/共/括号各形态", () => {
  assert.equal(extractEpisodeCount("xxx 更新至98集 [夸克网盘]"), 98);
  assert.equal(extractEpisodeCount("xxx 全80集"), 80);
  assert.equal(extractEpisodeCount("镇国驸马爷3D版（252集）"), 252);
  assert.equal(extractEpisodeCount("连载至 第36集"), 36);
  assert.equal(extractEpisodeCount("凤凰于飞 完结"), undefined);
});

test("stripEpisodeMarkers：剥集数与连载状态得到干净剧名", () => {
  assert.equal(stripEpisodeMarkers("xxx 更新至98集"), "xxx");
  assert.equal(stripEpisodeMarkers("凤凰于飞 全80集"), "凤凰于飞");
  assert.equal(stripEpisodeMarkers("请旨和离，转身嫁给战神王爷（91集）"), "请旨和离，转身嫁给战神王爷");
  assert.equal(stripEpisodeMarkers("夫妻的世界（未删减版）（40集）"), "夫妻的世界（未删减版）");
  assert.equal(stripEpisodeMarkers("凤凰于飞 完结"), "凤凰于飞");
});

test("formatDisplayTitle：kkpan 实测脏标题清洗（2026-09-10 全量样本归纳）", () => {
  // 「标题：N.」来源标注前缀 + 演员名单 + 清晰度标记
  assert.equal(
    formatDisplayTitle("标题：04.让你当zhui婿，没让你当zuo精啊 朱哲人＆张亚迪（1080P）"),
    "让你当zhui婿，没让你当zuo精啊"
  );
  // 全角＆多层演员名单
  assert.equal(
    formatDisplayTitle("葬神棺，埋人就变强 都钊＆张艺霖＆索菲＆雪碧＆闫妍"),
    "葬神棺，埋人就变强"
  );
  // 半角 & 演员名单
  assert.equal(formatDisplayTitle("重开吧，陛下 李沛洋&鲁照华"), "重开吧，陛下");
  // 拆字竖线（规避审核写法）
  assert.equal(
    formatDisplayTitle("少｜爷他老是犯｜jian，夫人她专治不fu！第二季"),
    "少爷他老是犯jian，夫人她专治不fu！第二季"
  );
  // 下划线副标题
  assert.equal(formatDisplayTitle("步步倾心_小侯爷专宠郡主"), "步步倾心 小侯爷专宠郡主");
  // AI 版 / AI 真人版 尾缀
  assert.equal(formatDisplayTitle("江先生，别太野AI版"), "江先生，别太野");
  assert.equal(formatDisplayTitle("我刻薄不是装的AI真人版"), "我刻薄不是装的");
  // 残缺集数形态（（集）19 / （集119））与空括号
  assert.equal(formatDisplayTitle("萌猫重生觅真相（集）19"), "萌猫重生觅真相");
  assert.equal(
    formatDisplayTitle("开局人字拖我被校花培养成百变契灵（集119）"),
    "开局人字拖我被校花培养成百变契灵"
  );
  assert.equal(formatDisplayTitle("归墟第一季（ ）"), "归墟第一季");
  // 剧名内的数字与系列序号不受影响
  assert.equal(formatDisplayTitle("沐糖1：姐姐别逃，心跳超标 朱哲人&刘入鸣"), "沐糖1：姐姐别逃，心跳超标");
  assert.equal(formatDisplayTitle("重生83：我驭兽打猎赶山进货 孙军＆椿添（1080P）"), "重生83：我驭兽打猎赶山进货");
});

test("formatDisplayTitle：两遍清洗（标记剥除后暴露的尾缀）与集数全形态", () => {
  // 演员名单前有 & 空格间隔
  assert.equal(formatDisplayTitle("皑如山上雪2（88集）王晨鹏 &贾翼瑄"), "皑如山上雪2");
  // 「（5集全）」+ 清晰度注记 + 版本修饰尾缀
  assert.equal(
    formatDisplayTitle("标题：极昼血祭（5集全）（1080P.高码）（铂金珍藏版）"),
    "极昼血祭"
  );
  // 剧名内部含 &（双主角剧名）不误伤
  assert.equal(
    formatDisplayTitle("标题：10.真千金她不装了，嫡女归来炸场＆宴辞予蓝音（70集）谭圳豪＆权睿（1080P）"),
    "真千金她不装了，嫡女归来炸场&宴辞予蓝音"
  );
});

test("extractEpisodeCount：残缺形态（集119）/（集）19", () => {
  assert.equal(extractEpisodeCount("开局人字拖我被校花培养成百变契灵（集119）"), 119);
  assert.equal(extractEpisodeCount("萌猫重生觅真相（集）19"), 19);
});

test("buildContentKey：清洗后同剧不同来源写法归一到同一键", () => {
  const keyOf = (raw: string) => buildContentKey(formatDisplayTitle(raw));
  // 同剧：带/不带演员名单、带/不带清晰度标记、更新进度不同
  assert.equal(
    keyOf("一品猎罪师 潘子剑＆陈思彤（1080P）"),
    keyOf("一品猎罪师")
  );
  assert.equal(
    keyOf("凤凰于飞 全80集 [夸克网盘]"),
    keyOf("凤凰于飞 更新至12集 [夸克网盘]")
  );
  // 非文字数字串折叠 + 小写
  assert.equal(buildContentKey("ABC 123"), buildContentKey("abc-123"));
});

// ---------------------------------------------------------------------------
// 单行解析
// ---------------------------------------------------------------------------

function baseRow(extra: Partial<Parameters<typeof parseKkpanResourceRow>[0]> = {}) {
  return {
    id: 101,
    file_name: "凤凰于飞 更新至98集 [夸克网盘]",
    description: "一段简介",
    share_link: "https://pan.quark.cn/s/abc",
    share_code: "3xK9",
    updated_at: "2026-09-01T10:00:00.000Z",
    ...extra,
  } as Parameters<typeof parseKkpanResourceRow>[0];
}

test("parseKkpanResourceRow：完整字段映射", () => {
  const parsed = parseKkpanResourceRow(baseRow());
  assert.ok(parsed);
  assert.equal(parsed!.resourceId, "101");
  assert.equal(parsed!.title, "凤凰于飞");
  assert.equal(parsed!.episodeCount, 98);
  assert.equal(parsed!.shareUrl, "https://pan.quark.cn/s/abc");
  assert.equal(parsed!.shareCode, "3xK9");
  assert.equal(parsed!.description, "一段简介");
  assert.equal(parsed!.publicUpdatedAt, "2026-09-01T10:00:00.000Z");
});

test("parseKkpanResourceRow：真实 kkpan 样本（序号前缀 + AI短剧后缀）", () => {
  // 2026-09-10 线上 API 实测样本
  const parsed = parseKkpanResourceRow(
    baseRow({
      id: 3888240,
      file_name: "178.微光照亮我的余生（40集）AI短剧 [夸克网盘]",
      description: null,
      share_code: null,
      updated_at: "2026-09-08T18:34:04.198Z",
    })
  );
  assert.ok(parsed);
  assert.equal(parsed!.resourceId, "3888240");
  assert.equal(parsed!.title, "微光照亮我的余生");
  assert.equal(parsed!.episodeCount, 40);
  assert.equal(parsed!.contentKey, "微光照亮我的余生");
  assert.equal(parsed!.shareCode, undefined);
});

test("parseKkpanResourceRow：非夸克链接/空链接/空标题/坏时间拒绝", () => {
  assert.equal(parseKkpanResourceRow(baseRow({ share_link: null })), null);
  assert.equal(
    parseKkpanResourceRow(baseRow({ share_link: "https://pan.baidu.com/s/x" })),
    null
  );
  assert.equal(parseKkpanResourceRow(baseRow({ file_name: "[夸克网盘]" })), null);
  assert.equal(parseKkpanResourceRow(baseRow({ updated_at: "" })), null);
  assert.equal(parseKkpanResourceRow(baseRow({ updated_at: "not-a-date" })), null);
});

// ---------------------------------------------------------------------------
// 同剧折叠
// ---------------------------------------------------------------------------

function rowFor(key: string, episode: number | undefined, updatedAt: string, id: string): ParsedKkpanResource {
  return {
    resourceId: id,
    contentKey: key,
    title: "剧名",
    ...(episode !== undefined ? { episodeCount: episode } : {}),
    shareUrl: "https://pan.quark.cn/s/x",
    publicUpdatedAt: updatedAt,
  };
}

test("collapseByContentKey：同剧保留集数最大者", () => {
  const { kept, collapsed } = collapseByContentKey([
    rowFor("剧名", 50, "2026-09-01T00:00:00.000Z", "1"),
    rowFor("剧名", 98, "2026-08-20T00:00:00.000Z", "2"),
  ]);
  assert.equal(collapsed, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].resourceId, "2");
});

test("collapseByContentKey：集数同则取最近更新", () => {
  const { kept } = collapseByContentKey([
    rowFor("剧名", 98, "2026-08-20T00:00:00.000Z", "1"),
    rowFor("剧名", 98, "2026-09-01T00:00:00.000Z", "2"),
  ]);
  assert.equal(kept[0].resourceId, "2");
});

test("collapseByContentKey：不同剧互不折叠", () => {
  const { kept, collapsed } = collapseByContentKey([
    rowFor("剧名一", 98, "2026-09-01T00:00:00.000Z", "1"),
    rowFor("剧名二", undefined, "2026-09-01T00:00:00.000Z", "2"),
  ]);
  assert.equal(collapsed, 0);
  assert.equal(kept.length, 2);
});

console.log("kkpan-sync tests done");
