/**
 * 元数据三件套大类挑选单元测试（纯函数，无网络）
 *
 * 背景：kkpan 转存来源多、分享夹命名五花八门（实测：文本有 简介.txt/
 * 详细简介.txt/视频信息.txt，图片有 封面.jpg/0.jpg/海报.jpg/剧名.jpg），
 * 识别按文件大类 + 大类内优先级挑选，不依赖固定文件名。
 *
 * 运行：npx tsx tests/metadata-pick.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  pickCoverFile,
  pickIntroFile,
  pickMetadataFile,
} from "@/lib/short-drama/metadata-sync";

test("pickCoverFile：封面/海报关键词命名优先（含此前漏掉的「海报」）", () => {
  const images = [
    { name: "0.jpg", size: 100_000 },
    { name: "海报.jpg", size: 500_000 },
  ];
  assert.equal(pickCoverFile(images)!.name, "海报.jpg");
  assert.equal(
    pickCoverFile([{ name: "封面.jpg" }, { name: "0.jpg" }])!.name,
    "封面.jpg"
  );
  assert.equal(
    pickCoverFile([{ name: "poster.webp" }, { name: "1.png" }])!.name,
    "poster.webp"
  );
});

test("pickCoverFile：剧名同名图优先于体积", () => {
  const images = [
    { name: "0.jpg", size: 900_000 },
    { name: "两界穿梭：夫君小我一千岁.jpg", size: 100_000 },
  ];
  assert.equal(
    pickCoverFile(images, "两界穿梭：夫君小我一千岁")!.name,
    "两界穿梭：夫君小我一千岁.jpg"
  );
});

test("pickCoverFile：无关键词时取体积最大（海报通常大于截图/缩略图）", () => {
  const images = [
    { name: "a.jpg", size: 50_000 },
    { name: "b.png", size: 800_000 },
    { name: "c.jpg", size: 120_000 },
  ];
  assert.equal(pickCoverFile(images)!.name, "b.png");
  // 无 size 信息退回原始顺序
  assert.equal(pickCoverFile([{ name: "x.jpg" }, { name: "y.jpg" }])!.name, "x.jpg");
  assert.equal(pickCoverFile([]), undefined);
});

test("pickIntroFile：详细简介 > 简介 > 普通文本 > 视频信息（技术参数垫底）", () => {
  const texts = [
    { name: "视频信息.txt", size: 9_000 },
    { name: "简介.txt", size: 5_000 },
    { name: "详细简介.txt", size: 8_000 },
  ];
  assert.equal(pickIntroFile(texts)!.name, "详细简介.txt");
  assert.equal(
    pickIntroFile([{ name: "视频信息.txt" }, { name: "剧情介绍.md" }])!.name,
    "剧情介绍.md"
  );
  // 只有技术参数文件时仍然采用（聊胜于无），不因命名固定而放弃文本类
  assert.equal(pickIntroFile([{ name: "视频信息.txt" }])!.name, "视频信息.txt");
  // 同级取体积最大（更长更完整）
  assert.equal(
    pickIntroFile([
      { name: "info.txt", size: 1_000 },
      { name: "story.txt", size: 20_000 },
    ])!.name,
    "story.txt"
  );
  assert.equal(pickIntroFile([]), undefined);
});

test("pickMetadataFile：精确 metadata.json 优先，其次体积最大的任意 json", () => {
  assert.equal(
    pickMetadataFile([{ name: "data.json", size: 100 }, { name: "metadata.json", size: 1 }])!
      .name,
    "metadata.json"
  );
  assert.equal(
    pickMetadataFile([{ name: "info.json", size: 50 }, { name: "list.json", size: 900 }])!.name,
    "list.json"
  );
  assert.equal(pickMetadataFile([]), undefined);
});
