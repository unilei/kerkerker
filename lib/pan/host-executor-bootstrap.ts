/** Start the KKPAN generic host only during an explicit, fenced cutover. */

import {
  createPanCatalogHostJobHandlerRegistry,
} from "@/lib/pan/host-job-handler";
import { reconcilePanCatalogCutoverProjections } from "@/lib/pan/scheduler";
import {
  PluginHostExecutor,
} from "@/lib/plugins/job-executor";
import { PluginJobRunner } from "@/lib/plugins/job-runner";
import { getMongoPluginJobStore } from "@/lib/plugins/mongo-job-store";

const globalBootstrap = globalThis as unknown as {
  panCatalogHostExecutor?: PluginHostExecutor;
  panCatalogHostExecutorStarted?: boolean;
};

function integerEnv(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * This function is deliberately a no-op unless both migration gates are set.
 * It is safe to call from Next.js instrumentation on every worker instance.
 */
export async function startPanCatalogHostExecutor(): Promise<boolean> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return false;
  if (process.env.PAN_SYNC_CATALOG_JOB_MODE !== "cutover") return false;
  if (process.env.PAN_SYNC_SCHEDULER_DISABLED !== "true") {
    console.error(
      "KKPAN generic cutover 已配置，但 PAN_SYNC_SCHEDULER_DISABLED 不是 true；宿主执行器保持关闭"
    );
    return false;
  }
  if (globalBootstrap.panCatalogHostExecutorStarted) return true;
  globalBootstrap.panCatalogHostExecutorStarted = true;
  try {
    const repaired = await reconcilePanCatalogCutoverProjections();
    if (repaired > 0) {
      console.log(`已修复 ${repaired} 个 KKPAN cutover 兼容投影标记`);
    }
    const runner = new PluginJobRunner(await getMongoPluginJobStore());
    const executor = new PluginHostExecutor(
      {
        runner,
        handlers: createPanCatalogHostJobHandlerRegistry({ production: true }),
      },
      {
        owner:
          process.env.PAN_SYNC_HOST_OWNER?.trim() ||
          `pan-catalog-host-${process.pid}`,
        leaseTtlMs: integerEnv("PAN_SYNC_HOST_LEASE_TTL_MS", undefined),
        pollIntervalMs: integerEnv("PAN_SYNC_HOST_POLL_MS", 5_000),
        heartbeatIntervalMs: integerEnv(
          "PAN_SYNC_HOST_HEARTBEAT_MS",
          30_000
        ),
        cancellationPollIntervalMs: integerEnv(
          "PAN_SYNC_HOST_CANCEL_POLL_MS",
          2_000
        ),
      }
    );
    globalBootstrap.panCatalogHostExecutor = executor;
    void executor.run().catch((error) => {
      console.error(
        "KKPAN generic host executor 已停止:",
        error instanceof Error ? error.message : String(error)
      );
      globalBootstrap.panCatalogHostExecutorStarted = false;
    });
    console.log("✅ KKPAN generic host executor 已启动");
    return true;
  } catch (error) {
    globalBootstrap.panCatalogHostExecutorStarted = false;
    console.error(
      "KKPAN generic host executor 启动失败:",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

export function stopPanCatalogHostExecutor(reason?: string): void {
  globalBootstrap.panCatalogHostExecutor?.stop(reason);
  globalBootstrap.panCatalogHostExecutor = undefined;
  globalBootstrap.panCatalogHostExecutorStarted = false;
}
