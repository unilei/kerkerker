import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireAdminRequest } from "@/lib/admin-route";

/**
 * 后台同步既可以由登录用户触发，也可以由部署环境用 Bearer 密钥触发。
 * 密钥比较保持定长后再调用 timingSafeEqual，避免长度不同时抛异常。
 */
export function hasPanSyncCronSecret(
  request: Pick<NextRequest, "headers">
): boolean {
  const expected =
    process.env.KKPAN_SYNC_CRON_SECRET || process.env.CRON_SECRET || "";
  if (!expected) return false;

  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const actual = Buffer.from(match[1].trim());
  const expectedBuffer = Buffer.from(expected);
  return (
    actual.length === expectedBuffer.length &&
    timingSafeEqual(actual, expectedBuffer)
  );
}

export function requirePanSyncRequest(request: NextRequest) {
  const sessionResponse = requireAdminRequest(request);
  if (!sessionResponse || hasPanSyncCronSecret(request)) return null;
  return sessionResponse;
}
