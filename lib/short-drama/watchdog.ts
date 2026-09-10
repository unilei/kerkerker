/**
 * 单条处理看门狗：单条的全部网络步骤都有各自的 fetch 超时，但系统层
 * （如无超时的 DNS 解析挂起）仍可能让 Promise 永不落地，整轮任务
 * 静默停摆。正常单条 10~30s，10 分钟是宽裕上界；触发即本条按失败
 * 处理、继续下一条，不再拖死整轮。
 */

const PER_ITEM_WATCHDOG_MS = 10 * 60 * 1_000;

export class WatchdogTimeoutError extends Error {
  constructor(ms: number) {
    super(`单条处理超过看门狗时限（${Math.round(ms / 1000)}s），按失败跳过`);
    this.name = "WatchdogTimeoutError";
  }
}

/** 给单条处理加超时竞速；超时抛 WatchdogTimeoutError（不取消底层操作）。
 *  导出供单测直测时序语义。 */
export async function withWatchdog<T>(
  promise: Promise<T>,
  ms: number = PER_ITEM_WATCHDOG_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WatchdogTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
