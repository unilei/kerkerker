import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { normalizeQuarkCookie } from "@/lib/security/credential-crypto";
import {
  startQuarkQrLogin,
  pollQuarkQrLogin,
  probeQuarkNickname,
} from "@/lib/quark/qr-login";
import {
  USER_QUARK_SESSION_COOKIE,
  USER_QUARK_SESSION_TTL_MS,
  saveUserQuarkCredential,
  getUserQuarkCredential,
  getUserQuarkCookie,
  deleteUserQuarkCredential,
  rememberUserSavedItems,
  getUserSavedFids,
} from "@/lib/user-quark-credentials";
import { QuarkApiClient, collectQuarkVideoFiles, fetchQuarkDownloadUrlForFile, fetchQuarkPlayUrlForFile, listQuarkOwnDirectory, QuarkCredentialInvalidError } from "@/lib/quark/quark-api-client";
import type { QuarkOwnFileItem } from "@/lib/quark/quark-api-client";
import { getShortDramaById } from "@/lib/short-drama-db";
import { checkRateLimit, requestClientIp } from "@/lib/http-rate-limit";

/**
 * 访客夸克自助转存 + 试播 PoC（/quark-save-poc 测试页专用，匿名可访问）
 *
 * GET  action=status            → 当前会话登录状态
 * GET  action=qr_start          → 生成扫码登录二维码
 * GET  action=qr_poll&token&requestId → 轮询扫码状态（成功即落库凭证）
 * GET  action=files&dramaId     → 列出访客网盘里该剧的视频文件（需先转存）
 * GET  action=play&fid          → 取某文件的原画/转码播放直链
 * GET  action=proxy&fid         → 服务端代取直链并流式转发（Range 透传）
 * POST { action:"save", dramaId }      → 把该剧源站分享转存到访客网盘
 * POST { action:"logout" }             → 删除会话凭证
 *
 * 安全约束：
 * - 凭证 AES 加密落库，响应只回传登录态（昵称/剩余时长），绝不回传 cookie；
 * - 会话 ID 为服务端签发随机 UUID，HttpOnly + SameSite=Lax；
 * - qr_start / save / files / play / proxy 按 IP 限速，防夸克接口被滥用；
 * - save 只允许 done 状态且带源站链接的短剧，转存走访客自己的凭证；
 * - files / play 走访客自己的 cookie，天然只能触达访客自己网盘里的文件，
 *   fid 由服务端记录的转存产物而来（play 不另做归属校验，参数仅正则约束）。
 */

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action") || "status";
  const sessionId = request.cookies.get(USER_QUARK_SESSION_COOKIE)?.value || "";

  try {
    if (action === "status") {
      const credential = sessionId
        ? await getUserQuarkCredential(sessionId)
        : null;
      return NextResponse.json({
        code: 200,
        message: "ok",
        data: {
          logged_in: !!credential,
          nickname: credential?.nickname,
          expires_in_ms: credential?.expiresInMs,
        },
      });
    }

    if (action === "qr_start") {
      if (!checkRateLimit(`qr:${requestClientIp(request)}`, 10, 60_000)) {
        return NextResponse.json(
          { code: 429, message: "请求过于频繁，请稍后再试", data: null },
          { status: 429 }
        );
      }
      const qr = await startQuarkQrLogin(randomUUID());
      return NextResponse.json({ code: 200, message: "ok", data: qr });
    }

    if (action === "qr_poll") {
      const token = request.nextUrl.searchParams.get("token") || "";
      if (!token) {
        return NextResponse.json(
          { code: 400, message: "缺少 token", data: null },
          { status: 400 }
        );
      }
      if (!checkRateLimit(`qrpoll:${requestClientIp(request)}`, 120, 60_000)) {
        return NextResponse.json(
          { code: 429, message: "轮询过于频繁，请稍后再试", data: null },
          { status: 429 }
        );
      }
      const result = await pollQuarkQrLogin(token);
      if (result.status === "expired") {
        return NextResponse.json({
          code: 200,
          message: "ok",
          data: { status: "expired", message: result.message },
        });
      }
      if (result.status !== "ok") {
        return NextResponse.json({
          code: 200,
          message: "ok",
          data: { status: "pending" },
        });
      }
      // 扫码成功：签发/续签会话并落库加密凭证
      const newSessionId = randomUUID();
      await saveUserQuarkCredential({
        sessionId: newSessionId,
        cookie: result.cookie,
        nickname: result.nickname,
      });
      const response = NextResponse.json({
        code: 200,
        message: "ok",
        data: { status: "ok", nickname: result.nickname },
      });
      response.cookies.set(USER_QUARK_SESSION_COOKIE, newSessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: USER_QUARK_SESSION_TTL_MS / 1000,
        path: "/",
      });
      return response;
    }

    if (action === "files") {
      if (!checkRateLimit(`files:${requestClientIp(request)}`, 30, 60_000)) {
        return NextResponse.json(
          { code: 429, message: "请求过于频繁，请稍后再试", data: null },
          { status: 429 }
        );
      }
      const cookie = sessionId ? await getUserQuarkCookie(sessionId) : null;
      if (!cookie) {
        return NextResponse.json(
          { code: 401, message: "请先扫码登录夸克账号", data: null },
          { status: 401 }
        );
      }
      const dramaId = request.nextUrl.searchParams.get("dramaId") || "";
      if (!/^[a-f\d]{24}$/i.test(dramaId)) {
        return NextResponse.json(
          { code: 400, message: "dramaId 无效", data: null },
          { status: 400 }
        );
      }
      const drama = await getShortDramaById(dramaId);
      if (!drama) {
        return NextResponse.json(
          { code: 404, message: "短剧不存在", data: null },
          { status: 404 }
        );
      }
      let savedFids = await getUserSavedFids(sessionId, dramaId);

      const client = new QuarkApiClient({ cookie });
      let topItems: QuarkOwnFileItem[] | null = null;
      const loadSaveDirItems = async () => {
        if (!topItems) {
          const topDirFid = await client.getSaveAsFolderFid();
          topItems = await listQuarkOwnDirectory(cookie, topDirFid);
        }
        return topItems;
      };

      if (!savedFids || savedFids.length === 0) {
        // 兜底：转存产物记录上线前转存的剧没有 fid 记录（或换了会话），
        // 按剧名在默认「来自：分享」目录里认领，认领成功回填记录。
        // 源站分享的文件夹名形如「01.剧名（81集）演员」，归一化时去掉
        // 序号前缀和集数标记，再比剩余部分
        const normalize = (value: string) =>
          value
            .replace(/[（(]\d+集[)）]/g, "")
            .replace(/^\s*\d+\s*[.、\-_]\s*/, "")
            .replace(/\s+/g, "")
            .toLowerCase();
        const target = normalize(drama.title);
        const top = await loadSaveDirItems();
        const exact = top.filter((item) => normalize(item.name) === target);
        const matched =
          exact.length > 0
            ? exact
            : top.filter((item) => {
                const name = normalize(item.name);
                return (
                  name.length > 0 &&
                  (name.includes(target) || target.includes(name))
                );
              });
        if (matched.length > 0) {
          savedFids = matched.map((item) => item.fid);
          await rememberUserSavedItems(
            sessionId,
            dramaId,
            savedFids,
            drama.title
          );
        }
      }

      if (!savedFids || savedFids.length === 0) {
        return NextResponse.json(
          { code: 404, message: "尚未转存该剧：请先点「转存」，再回来试播", data: null },
          { status: 404 }
        );
      }
      // 从默认转存目录把根条目认出来（拿到真实文件名和目录标记）；
      // 认不出（被移动/改名）再按裸 fid 盲走，列表为空时按文件兜底
      let roots: QuarkOwnFileItem[] | null = null;
      try {
        const top = await loadSaveDirItems();
        const found = top.filter((item) => savedFids.includes(item.fid));
        if (found.length > 0) roots = found;
      } catch {
        roots = null;
      }
      const rootItems =
        roots ??
        savedFids.map((fid) => ({ fid, name: fid, size: null, dir: false }));
      const files = await collectQuarkVideoFiles(cookie, rootItems);
      if (files.length === 0) {
        return NextResponse.json(
          {
            code: 404,
            message: "在你的网盘里没找到该剧的视频文件（可能已被删除或移动）",
            data: null,
          },
          { status: 404 }
        );
      }
      files.sort((a, b) =>
        a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true })
      );
      return NextResponse.json({
        code: 200,
        message: "ok",
        data: {
          title: drama.title,
          files: files.slice(0, 200).map((file) => ({
            fid: file.fid,
            name: file.name,
            size: file.size,
          })),
        },
      });
    }

    if (action === "play") {
      if (!checkRateLimit(`play:${requestClientIp(request)}`, 30, 60_000)) {
        return NextResponse.json(
          { code: 429, message: "请求过于频繁，请稍后再试", data: null },
          { status: 429 }
        );
      }
      const cookie = sessionId ? await getUserQuarkCookie(sessionId) : null;
      if (!cookie) {
        return NextResponse.json(
          { code: 401, message: "请先扫码登录夸克账号", data: null },
          { status: 401 }
        );
      }
      const fid = request.nextUrl.searchParams.get("fid") || "";
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(fid)) {
        return NextResponse.json(
          { code: 400, message: "fid 无效", data: null },
          { status: 400 }
        );
      }
      // 说明：fid 只用于拼夸克请求体，播放走访客自己的 cookie，天然只能
      // 访问到访客自己网盘里的文件，无需校验 fid 归属
      const result = await fetchQuarkPlayUrlForFile(cookie, fid);
      return NextResponse.json({
        code: 200,
        message: "ok",
        data: {
          playUrl: result.playUrl,
          kind: result.kind,
          ...(result.resolution ? { resolution: result.resolution } : {}),
          ...(result.fileName ? { fileName: result.fileName } : {}),
        },
      });
    }

    if (action === "proxy") {
      // 浏览器实测：跨站 <video> 请求不带 __puus（SameSite 拦截），直链裸播 412，
      // 因此由服务端带访客 cookie 取直链并流式转发。Range 头透传以支持拖进度条。
      // 注意：流量过站，正式化时需评估带宽与 CF 代理 ToS。
      if (!checkRateLimit(`proxy:${requestClientIp(request)}`, 120, 60_000)) {
        return NextResponse.json(
          { code: 429, message: "请求过于频繁，请稍后再试", data: null },
          { status: 429 }
        );
      }
      const cookie = sessionId ? await getUserQuarkCookie(sessionId) : null;
      if (!cookie) {
        return NextResponse.json(
          { code: 401, message: "请先扫码登录夸克账号", data: null },
          { status: 401 }
        );
      }
      const fid = request.nextUrl.searchParams.get("fid") || "";
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(fid)) {
        return NextResponse.json(
          { code: 400, message: "fid 无效", data: null },
          { status: 400 }
        );
      }
      const { downloadUrl } = await fetchQuarkDownloadUrlForFile(cookie, fid);
      const range = request.headers.get("range") || "";
      const upstream = await fetch(downloadUrl, {
        headers: {
          ...(range ? { range } : {}),
          cookie,
        },
        // 流式播放不能设整体超时（会掐断长视频），直链本身是预签名的
      });
      if (!upstream.ok && upstream.status !== 206) {
        return NextResponse.json(
          {
            code: 502,
            message: `夸克 CDN 拒绝了代理播放 (HTTP ${upstream.status})`,
            data: null,
          },
          { status: 502 }
        );
      }
      const headers = new Headers();
      for (const name of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
      ]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
      headers.set("cache-control", "private, no-store");
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers,
      });
    }

    return NextResponse.json(
      { code: 400, message: `未知 action: ${action}`, data: null },
      { status: 400 }
    );
  } catch (error) {
    if (error instanceof QuarkCredentialInvalidError) {
      return NextResponse.json(
        { code: 401, message: "夸克登录已失效，请重新扫码登录", data: null },
        { status: 401 }
      );
    }
    return NextResponse.json(
      {
        code: 502,
        message: error instanceof Error ? error.message : "夸克接口请求失败",
        data: null,
      },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  if ((request.headers.get("content-type") || "").includes("application/json")) {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  const action = typeof body.action === "string" ? body.action : "";
  const sessionId = request.cookies.get(USER_QUARK_SESSION_COOKIE)?.value || "";

  try {
    if (action === "logout") {
      if (sessionId) await deleteUserQuarkCredential(sessionId);
      const response = NextResponse.json({
        code: 200,
        message: "ok",
        data: { logged_in: false },
      });
      response.cookies.set(USER_QUARK_SESSION_COOKIE, "", { maxAge: 0, path: "/" });
      return response;
    }

    if (action === "cookie_login") {
      if (!checkRateLimit(`cookielogin:${requestClientIp(request)}`, 5, 60_000)) {
        return NextResponse.json(
          { code: 429, message: "请求过于频繁，请稍后再试", data: null },
          { status: 429 }
        );
      }
      const rawCookie = typeof body.cookie === "string" ? body.cookie : "";
      if (!rawCookie.trim()) {
        return NextResponse.json(
          { code: 400, message: "请粘贴 cookie", data: null },
          { status: 400 }
        );
      }
      const cookie = normalizeQuarkCookie(rawCookie);
      const nickname = await probeQuarkNickname(cookie);
      if (!nickname) {
        // 探测失败大概率是 cookie 无效，让用户检查而不是存一堆死凭证
        return NextResponse.json(
          {
            code: 401,
            message: "cookie 校验失败：无法读取账号信息，请确认已登录 pan.quark.cn 后重新复制",
            data: null,
          },
          { status: 401 }
        );
      }
      const newSessionId = randomUUID();
      await saveUserQuarkCredential({ sessionId: newSessionId, cookie, nickname });
      const response = NextResponse.json({
        code: 200,
        message: "ok",
        data: { status: "ok", nickname },
      });
      response.cookies.set(USER_QUARK_SESSION_COOKIE, newSessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: USER_QUARK_SESSION_TTL_MS / 1000,
        path: "/",
      });
      return response;
    }

    if (action === "save") {
      if (!checkRateLimit(`save:${requestClientIp(request)}`, 10, 60_000)) {
        return NextResponse.json(
          { code: 429, message: "转存请求过于频繁，请稍后再试", data: null },
          { status: 429 }
        );
      }
      const cookie = sessionId ? await getUserQuarkCookie(sessionId) : null;
      if (!cookie) {
        return NextResponse.json(
          { code: 401, message: "请先扫码登录夸克账号", data: null },
          { status: 401 }
        );
      }
      const dramaId = typeof body.dramaId === "string" ? body.dramaId : "";
      const drama = await getShortDramaById(dramaId);
      if (!drama || !drama.share_url) {
        return NextResponse.json(
          { code: 404, message: "短剧不存在或没有可转存的分享链接", data: null },
          { status: 404 }
        );
      }
      // 用访客自己的凭证转存 kkpan 的分享链接：存进访客网盘的默认「来自：分享」目录
      const client = new QuarkApiClient({ cookie });
      const result = await client.transferOnly(drama.share_url);
      // 记住转存产物 fid，试播（action=files）据此定位访客网盘里的剧集文件
      await rememberUserSavedItems(
        sessionId,
        dramaId,
        result.savedFids,
        result.title || drama.title
      );
      return NextResponse.json({
        code: 200,
        message: "ok",
        data: {
          saved: result.savedFids.length,
          title: result.title || drama.title,
          ...(result.filteredMessage ? { warning: result.filteredMessage } : {}),
        },
      });
    }

    return NextResponse.json(
      { code: 400, message: `未知 action: ${action}`, data: null },
      { status: 400 }
    );
  } catch (error) {
    if (error instanceof QuarkCredentialInvalidError) {
      return NextResponse.json(
        { code: 401, message: "夸克登录已失效，请重新扫码登录", data: null },
        { status: 401 }
      );
    }
    return NextResponse.json(
      {
        code: 502,
        message: error instanceof Error ? error.message : "夸克接口请求失败",
        data: null,
      },
      { status: 502 }
    );
  }
}
