import { NextResponse } from "next/server";

/**
 * IndexNow 密钥校验文件：GET /indexnow-key.txt 返回 INDEXNOW_KEY
 * 明文。IndexNow 规范要求 key 文件能从提交域名直接 GET 到，且不能
 * 放在 robots 屏蔽路径下，所以单独放根路径而不进 /api/。
 * 未配置 INDEXNOW_KEY 时返回 404。
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.INDEXNOW_KEY?.trim();
  if (!key) {
    return new NextResponse("IndexNow key not configured", { status: 404 });
  }
  return new NextResponse(key, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
