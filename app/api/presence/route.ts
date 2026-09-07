import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, requestClientIp } from "@/lib/http-rate-limit";
import { touchPresence, countOnline } from "@/lib/presence";

/**
 * 在线人数心跳（匿名，内存统计，不落库不存 IP）
 *
 * POST { visitorId } → 记录心跳并返回当前在线人数
 * GET                → 仅查询当前在线人数
 *
 * visitorId 是前端生成的随机 UUID（localStorage 持久化），仅用于
 * 去重计数；校验格式防注入，无效 ID 只返回计数不计心跳。
 */

/** visitorId 白名单：UUID / 时间戳+随机串格式（8-64 位 URL 安全字符） */
const VISITOR_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // 单访客 60s 一跳，30 次/分钟/IP 足够宽裕，防滥用即可
  if (!checkRateLimit(`presence:${requestClientIp(request)}`, 30, 60_000)) {
    return NextResponse.json(
      { code: 429, message: "请求过于频繁", data: null },
      { status: 429 }
    );
  }

  let visitorId = "";
  try {
    const body = (await request.json()) as { visitorId?: unknown };
    if (typeof body?.visitorId === "string") visitorId = body.visitorId;
  } catch {
    // 无 body / 非法 JSON：按查询处理
  }

  const online = VISITOR_ID_RE.test(visitorId)
    ? touchPresence(visitorId)
    : countOnline();
  return NextResponse.json({ code: 200, message: "ok", data: { online } });
}

export async function GET() {
  return NextResponse.json({
    code: 200,
    message: "ok",
    data: { online: countOnline() },
  });
}
