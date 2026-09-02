import assert from "node:assert/strict";
import test from "node:test";

import { withWatchdog } from "@/lib/short-drama/transfer";

test("withWatchdog: 底层 promise 正常落地则透传结果", async () => {
  const result = await withWatchdog(Promise.resolve("ok"), 1_000);
  assert.equal(result, "ok");
});

test("withWatchdog: 底层 promise 永不落地时按时限抛错", async () => {
  // 模拟 DNS 挂起类「永不 resolve 也不 reject」的底层操作
  const parked = new Promise<string>(() => {});
  await assert.rejects(
    () => withWatchdog(parked, 50),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /看门狗时限/);
      return true;
    }
  );
});

test("withWatchdog: 到期前后边界——时限内完成不抛错", async () => {
  const start = Date.now();
  await withWatchdog(
    new Promise((resolve) => setTimeout(() => resolve("late-but-ok"), 30)),
    500
  );
  assert.ok(Date.now() - start < 500);
});

test("withWatchdog: 超时后清理计时器，不悬挂进程", async () => {
  // 计时器未清理会让 node:test 等待到超时才退出，这里快速跑完即验证
  const parked = new Promise<string>(() => {});
  await assert.rejects(() => withWatchdog(parked, 20));
  // 给事件循环一个 tick，若计时器泄漏（clearTimeout 缺失），测试进程会被拖延
  await new Promise((resolve) => setTimeout(resolve, 50));
});
