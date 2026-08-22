import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryPluginJobStore,
  PluginJobError,
  PluginJobRunner,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobRunnerPort,
} from "@/lib/plugins/job-runner";
import {
  createPluginJobHandlerRegistry,
  PluginHostExecutor,
  type PluginJobHandlerRegistration,
} from "@/lib/plugins/job-executor";

const JOB_ID = "example.host-task";
const PLUGIN_ID = "example.plugin";

function makeRunner() {
  const store = new InMemoryPluginJobStore();
  const runner = new PluginJobRunner(store, {
    defaultLeaseTtlMs: 100,
    defaultRetryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
  });
  return { store, runner };
}

async function enqueue(runner: PluginJobRunnerPort, jobId = JOB_ID) {
  return runner.enqueue({
    jobId,
    pluginId: PLUGIN_ID,
    pluginVersion: "1.0.0",
    profileId: "cn-default",
    profile: "cn-default",
    configVersion: "config-1",
    actor: { type: "system", id: "executor-test" },
    idempotencyKey: `executor:${jobId}:${Math.random()}`,
  });
}

function registration(
  execute: PluginJobHandlerRegistration["execute"],
  jobId = JOB_ID
): PluginJobHandlerRegistration {
  return { jobId, pluginId: PLUGIN_ID, pluginVersion: "1.0.0", execute };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 1000
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("等待测试状态超时");
    await delay(5);
  }
}

test("宿主执行器只领取静态注册的 job_id", async () => {
  const { store, runner } = makeRunner();
  const unknown = await enqueue(runner, "example.unknown");
  const handlers = createPluginJobHandlerRegistry([
    registration(async () => undefined),
  ]);
  const executor = new PluginHostExecutor(
    { runner, handlers },
    { owner: "host-static", pollIntervalMs: 5, cancellationPollIntervalMs: 5 }
  );

  assert.equal(await executor.runOnce(), null);
  assert.equal((await store.get(unknown.run_id))?.status, "queued");
  assert.throws(
    () => createPluginJobHandlerRegistry([registration(async () => undefined), registration(async () => undefined)]),
    /重复注册/
  );
});

test("并发宿主执行器对同一个任务只有一个领取者", async () => {
  const { runner } = makeRunner();
  await enqueue(runner);
  let executions = 0;
  const handlers = createPluginJobHandlerRegistry([
    registration(async () => {
      executions += 1;
    }),
  ]);
  const first = new PluginHostExecutor({ runner, handlers }, { owner: "host-a", cancellationPollIntervalMs: 5 });
  const second = new PluginHostExecutor({ runner, handlers }, { owner: "host-b", cancellationPollIntervalMs: 5 });
  const results = await Promise.all([first.runOnce(), second.runOnce()]);

  assert.equal(executions, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean)?.status, "succeeded");
});

test("取消请求会中止正在执行的处理器并收敛为 cancelled", async () => {
  const { store, runner } = makeRunner();
  const queued = await enqueue(runner);
  let aborted = false;
  const handlers = createPluginJobHandlerRegistry([
    registration(({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      })
    ),
  ]);
  const executor = new PluginHostExecutor(
    { runner, handlers },
    { owner: "host-cancel", cancellationPollIntervalMs: 5 }
  );
  const running = executor.runOnce();
  await waitFor(async () => (await store.get(queued.run_id))?.status === "running");
  assert.equal(await runner.requestCancel(queued.run_id) !== null, true);
  const finished = await running;

  assert.equal(aborted, true);
  assert.equal(finished?.status, "cancelled");
  assert.equal((await store.get(queued.run_id))?.status, "cancelled");
});

test("处理器异常会以失败终态保存且不泄露租约 token", async () => {
  const { store, runner } = makeRunner();
  const queued = await enqueue(runner);
  const handlers = createPluginJobHandlerRegistry([
    registration(async () => {
      throw new Error("上游暂时不可用");
    }),
  ]);
  const executor = new PluginHostExecutor({ runner, handlers }, { owner: "host-error" });
  const finished = await executor.runOnce();

  assert.equal(finished?.status, "failed");
  assert.equal(finished?.error?.code, "HOST_EXECUTOR_ERROR");
  assert.equal(finished?.lease, undefined);
  assert.equal((await store.get(queued.run_id))?.finished_at !== undefined, true);
});

test("心跳失去租约时中止处理器且不使用旧 token 写终态", async () => {
  const { store, runner } = makeRunner();
  const queued = await enqueue(runner);
  let aborted = false;
  const originalHeartbeat = runner.heartbeat.bind(runner);
  runner.heartbeat = async () => {
    throw new PluginJobError(
      PLUGIN_JOB_ERROR_CODES.LEASE_REQUIRED,
      "测试接管了租约"
    );
  };
  const handlers = createPluginJobHandlerRegistry([
    registration(({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      })
    ),
  ]);
  const executor = new PluginHostExecutor(
    { runner, handlers },
    { owner: "host-lost", leaseTtlMs: 100, heartbeatIntervalMs: 100, cancellationPollIntervalMs: 5 }
  );
  const result = await executor.runOnce();
  const stillRunning = await store.get(queued.run_id);

  assert.equal(aborted, true);
  assert.equal(result?.status, "running");
  assert.equal(stillRunning?.status, "running");
  assert.equal(stillRunning?.finished_at, undefined);
  assert.ok(stillRunning?.lease?.token);

  runner.heartbeat = originalHeartbeat;
  await delay(120);
  const takeover = await runner.claimNext({
    owner: "host-new",
    jobIds: [JOB_ID],
    leaseTtlMs: 100,
  });
  assert.equal(takeover?.run_id, queued.run_id);
  assert.equal(takeover?.lease_fence, 2);
  assert.notEqual(takeover?.lease?.token, stillRunning?.lease?.token);
});
