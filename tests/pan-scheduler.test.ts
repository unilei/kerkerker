import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  calculateNextPanSyncRunAt,
  defaultPanSyncSchedule,
  isPanSyncScheduleDue,
  normalizePanSyncRunMetadata,
} from "@/lib/pan/scheduler";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";
import {
  GET as getScheduler,
  POST as updateScheduler,
} from "@/app/api/pan-resources/scheduler/route";

function authenticatedRequest(body: string) {
  const secret = "pan-scheduler-test-secret";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest("http://localhost/api/pan-resources/scheduler", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    },
    body,
  });
}

test("后台调度 API 不允许未登录用户读取日志或启动任务", async () => {
  const getResponse = await getScheduler(
    new NextRequest("http://localhost/api/pan-resources/scheduler")
  );
  assert.equal(getResponse.status, 401);

  const postResponse = await updateScheduler(
    new NextRequest("http://localhost/api/pan-resources/scheduler", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "run_now", task: "catalog" }),
    })
  );
  assert.equal(postResponse.status, 401);
});

test("后台调度 API 对非法 JSON 和任务类型返回 400", async () => {
  const malformed = await updateScheduler(authenticatedRequest("{"));
  assert.equal(malformed.status, 400);

  const invalidTask = await updateScheduler(
    authenticatedRequest(JSON.stringify({ action: "run_now", task: "unknown" }))
  );
  assert.equal(invalidTask.status, 400);
});

test("Asia/Shanghai 每日执行时间会计算到正确的下一次 UTC 时刻", () => {
  const schedule = {
    ...defaultPanSyncSchedule("catalog"),
    enabled: true,
    hour: 3,
    minute: 0,
    timezone: "Asia/Shanghai",
  };
  assert.equal(
    calculateNextPanSyncRunAt(schedule, new Date("2026-08-18T18:00:00.000Z")),
    "2026-08-18T19:00:00.000Z"
  );
  assert.equal(
    calculateNextPanSyncRunAt(schedule, new Date("2026-08-18T20:00:00.000Z")),
    "2026-08-19T19:00:00.000Z"
  );
});

test("调度器仅在启用且 next_run_at 到期后执行", () => {
  const base = {
    ...defaultPanSyncSchedule("catalog"),
    enabled: true,
    next_run_at: "2026-08-19T03:00:00.000Z",
  };
  assert.equal(
    isPanSyncScheduleDue(base, new Date("2026-08-19T02:59:59.000Z")),
    false
  );
  assert.equal(
    isPanSyncScheduleDue(base, new Date("2026-08-19T03:00:00.000Z")),
    true
  );
  assert.equal(
    isPanSyncScheduleDue({ ...base, enabled: false }, new Date("2026-08-20T03:00:00.000Z")),
    false
  );
});

test("历史调度记录读取时补齐 KKPAN 元数据且不继承当前部署配置", () => {
  const metadata = normalizePanSyncRunMetadata({ run_id: "legacy-run" });
  assert.equal(metadata.plugin_id, KKPAN_PLUGIN_ID);
  assert.equal(metadata.plugin_version, "legacy");
  assert.equal(metadata.profile_id, "cn-default");
  assert.equal(metadata.profile, "cn-default");
  assert.equal(metadata.config_version, "legacy");
  assert.deepEqual(metadata.actor, { type: "system", id: "pan-scheduler" });
  assert.equal(metadata.idempotency_key, "pan-sync:legacy-run");
});

test("调度作业元数据支持插件、画像、配置版本和幂等键快照", () => {
  const metadata = normalizePanSyncRunMetadata({
    run_id: "tmdb-run",
    plugin_id: "kerkerker.tmdb-content",
    plugin_version: "1.2.3",
    profile_id: "en-default",
    profile: "en-default",
    config_version: "2026-08-21T00:00:00Z",
    actor: { type: "system", id: "job-runner" },
    idempotency_key: "job:tmdb:catalog:en-default:window-1",
  });
  assert.deepEqual(metadata, {
    plugin_id: "kerkerker.tmdb-content",
    plugin_version: "1.2.3",
    profile_id: "en-default",
    profile: "en-default",
    config_version: "2026-08-21T00:00:00Z",
    actor: { type: "system", id: "job-runner" },
    idempotency_key: "job:tmdb:catalog:en-default:window-1",
  });
});
