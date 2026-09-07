/**
 * 在线人数统计（单进程内存版，standalone 部署无共享状态需求）。
 *
 * 原理：前端持随机访客 ID（localStorage），每 60s 向 /api/presence
 * 发一次心跳；服务端记录「ID → 最后活跃时间」，统计窗口内的去重数
 * 即在线人数。不存 IP、不落库，进程重启归零重新累计。
 */

/** 在线判定窗口：5 分钟内有心跳即算在线 */
const ONLINE_WINDOW_MS = 5 * 60_000;

/** 防异常洪泛撑爆内存：超出后按最后活跃时间淘汰最旧一半 */
const MAX_TRACKED_VISITORS = 100_000;

const lastSeenById = new Map<string, number>();

function prune(now: number): void {
  for (const [id, seen] of lastSeenById) {
    if (now - seen > ONLINE_WINDOW_MS) lastSeenById.delete(id);
  }
  if (lastSeenById.size > MAX_TRACKED_VISITORS) {
    const entries = [...lastSeenById.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of entries.slice(0, Math.floor(entries.length / 2))) {
      lastSeenById.delete(id);
    }
  }
}

/** 记录一次心跳，返回当前在线人数 */
export function touchPresence(visitorId: string): number {
  const now = Date.now();
  prune(now);
  lastSeenById.set(visitorId, now);
  return lastSeenById.size;
}

/** 仅查询当前在线人数（不记录心跳） */
export function countOnline(): number {
  prune(Date.now());
  return lastSeenById.size;
}
