import { NextRequest, NextResponse } from "next/server";
import { requireAdminRequest } from "@/lib/admin-route";
import { normalizeQuarkCookie } from "@/lib/security/credential-crypto";
import { validateQuarkCredential } from "@/lib/quark/quark-api-client";
import {
  saveCloudCredential,
  getCloudCredentialView,
} from "@/lib/cloud-credentials-db";

/**
 * 网盘凭证管理（admin）
 *
 * POST   { platform: "quark", cookie: "__kps=...; __pus=...; __puus=..." }
 *        → 登录态字段初检 → 调夸克 member 接口验证 → AES 加密落库
 * GET    → 当前凭证脱敏视图（掩码 cookie + 有效性）
 */

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const view = await getCloudCredentialView("quark");
    return NextResponse.json({
      code: 200,
      message: "ok",
      data: { credential: view },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "读取凭证失败",
        data: null,
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdminRequest(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { code: 400, message: "请求体必须是 JSON", data: null },
      { status: 400 }
    );
  }

  const payload = body as { platform?: string; cookie?: string };
  if (payload.platform !== "quark") {
    return NextResponse.json(
      { code: 400, message: "仅支持 quark 平台凭证", data: null },
      { status: 400 }
    );
  }
  if (typeof payload.cookie !== "string" || payload.cookie.trim().length < 32) {
    return NextResponse.json(
      { code: 400, message: "cookie 内容无效", data: null },
      { status: 400 }
    );
  }

  let cookie: string;
  try {
    cookie = normalizeQuarkCookie(payload.cookie);
  } catch (error) {
    return NextResponse.json(
      {
        code: 400,
        message: error instanceof Error ? error.message : "cookie 格式无效",
        data: null,
      },
      { status: 400 }
    );
  }

  // 保存前先调夸克验证登录态
  let accountLabel: string | undefined;
  try {
    const member = await validateQuarkCredential(cookie);
    accountLabel = member.nickname || member.memberId || undefined;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "夸克凭证验证失败";
    const invalid = error instanceof Error && error.name === "QuarkCredentialInvalidError";
    return NextResponse.json(
      { code: invalid ? 422 : 502, message, data: null },
      { status: invalid ? 422 : 502 }
    );
  }

  try {
    const view = await saveCloudCredential({
      platform: "quark",
      cookie,
      ...(accountLabel ? { account_label: accountLabel } : {}),
    });
    return NextResponse.json({
      code: 200,
      message: "凭证已保存并通过验证",
      data: { credential: view },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 500,
        message: error instanceof Error ? error.message : "凭证保存失败",
        data: null,
      },
      { status: 500 }
    );
  }
}
