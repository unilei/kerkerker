#!/usr/bin/env node
/**
 * duanjugou 全量回填驱动：循环调用 admin scrape-backfill 分批抓取。
 *
 * 用法：node scripts/short-drama-backfill.mjs [maxDetails=500]
 * 环境变量：KERKERKER_BASE_URL（默认 http://localhost:3000）、
 *          ADMIN_PASSWORD（自动从项目根 .env 读取）
 *
 * 断点续跑：预算中断（budget_details/budget_pages）时把 stats.last_page 写入
 * scripts/.backfill-checkpoint.json，重启脚本自动从断点页继续；
 * stopped_reason 为 completed/empty_page/watermark 即回填收敛，脚本退出。
 * 用 node:http 而非 fetch：单批请求约 10 分钟，会超过 undici 默认 300s 响应头超时。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const checkpointPath = join(scriptDir, ".backfill-checkpoint.json");

for (const line of readFileSync(join(projectRoot, ".env"), "utf8").split("\n")) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].trim();
  }
}

const BASE_URL = process.env.KERKERKER_BASE_URL || "http://localhost:3000";
const PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_DETAILS = Number(process.argv[2]) || 500;
const MAX_HARD_FAILURES = 5;

if (!PASSWORD) {
  console.error("缺少 ADMIN_PASSWORD（.env）");
  process.exit(1);
}

function postJson(path, headers, body, timeoutMs = 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const mod = url.protocol === "https:" ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": data.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            // 非 JSON 响应按 null 处理，由调用方报错
          }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const now = () => new Date().toISOString();

const login = await postJson("/api/auth/login", {}, { password: PASSWORD });
if (login.status !== 200) {
  console.error(`登录失败: ${login.status} ${login.json ? JSON.stringify(login.json) : ""}`);
  process.exit(1);
}
const cookie = (login.headers["set-cookie"] ?? [])
  .map((entry) => entry.split(";")[0])
  .join("; ");
if (!cookie) {
  console.error("未拿到会话 cookie");
  process.exit(1);
}

let checkpoint = { startPage: 1, batches: 0, items: 0 };
if (existsSync(checkpointPath)) {
  try {
    checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch {
    // 损坏则重置
  }
}
console.log(`${now()} 回填启动：baseURL=${BASE_URL} maxDetails=${MAX_DETAILS} startPage=${checkpoint.startPage} 已入库=${checkpoint.items}`);

const saveCheckpoint = () =>
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

let hardFailures = 0;
for (let batch = 1; batch <= 5000; batch += 1) {
  let res;
  try {
    res = await postJson(
      "/api/admin/short-dramas",
      { cookie },
      {
        action: "scrape-backfill",
        maxDetails: MAX_DETAILS,
        startPage: checkpoint.startPage,
      }
    );
  } catch (error) {
    hardFailures += 1;
    console.error(`${now()} 批次 ${batch} 请求异常(${hardFailures}/${MAX_HARD_FAILURES}):`, error.message);
    if (hardFailures >= MAX_HARD_FAILURES) {
      console.error("连续失败过多，退出（checkpoint 未推进，重启脚本可续跑）");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    continue;
  }

  const stats = res.json?.data;
  if (res.status !== 200 || !stats) {
    const message = res.json?.message ?? res.status;
    // 租约被占（如上一批被中途重启）：等待租约过期后重试，不算硬失败
    if (typeof message === "string" && message.includes("已有抓取任务在运行")) {
      console.error(`${now()} 批次 ${batch} 租约被占，60s 后重试`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      continue;
    }
    hardFailures += 1;
    console.error(`${now()} 批次 ${batch} 失败(${hardFailures}/${MAX_HARD_FAILURES}): ${message}`);
    if (hardFailures >= MAX_HARD_FAILURES) {
      console.error("连续失败过多，退出（checkpoint 未推进，重启脚本可续跑）");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    continue;
  }

  hardFailures = 0;
  checkpoint.batches += 1;
  checkpoint.items += stats.items_created + stats.items_updated;
  console.log(
    `${now()} 批次 ${batch} 至第${stats.last_page}/${stats.site_max_page}页: ` +
      `+${stats.items_created} 新 / ${stats.items_updated} 更, 详情${stats.details_fetched}` +
      `(含夸克${stats.details_with_quark}), 失败页${stats.failed_pages}/详情${stats.failed_details}, ` +
      `累计入库 ${checkpoint.items}, 停止原因=${stats.stopped_reason}`
  );

  if (stats.stopped_reason === "budget_details" || stats.stopped_reason === "budget_pages") {
    checkpoint.startPage = stats.last_page;
    saveCheckpoint();
    continue;
  }

  // completed / empty_page / watermark → 回填收敛；断点归位，下次启动从第 1 页复查
  checkpoint.startPage = 1;
  saveCheckpoint();
  console.log(`${now()} 回填结束（${stats.stopped_reason}），共 ${checkpoint.batches} 批 / 累计入库 ${checkpoint.items} 条`);
  process.exit(0);
}

console.error(`${now()} 达到批次上限（5000），退出`);
process.exit(1);
