/**
 * Next.js Node runtime 启动钩子。
 *
 * 调度器自身只创建一个进程级轮询器，跨实例互斥和进度都由 MongoDB
 * 持久化；因此 Docker 重启后会自动恢复，不再依赖宿主机 crontab。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startPanSyncScheduler } = await import("./lib/pan/scheduler");
  startPanSyncScheduler();
}
