/**
 * 夸克扫码登录（社区逆向 CAS 接口，无官方 OAuth）
 *
 * 三步流程（对齐 xiaoya-alist / quarkdownloaderpro 实测可用的实现）：
 *   1. getTokenForQrcodeLogin 拿 token → 生成二维码内容（夸克 App 扫码）
 *   2. 轮询 getServiceTicketByQrcodeToken，扫码确认后从 data.members
 *      取 service_ticket
 *   3. 以 ?st={ticket}&lw=scan 访问 account/info 建立登录态，再依次
 *      访问 config / file-sort / member 补全 __puus 等下载必需 cookie
 *
 * 非官方接口，随官方改版可能失效；前端需提供「粘贴 cookie」兜底入口。
 * 所有请求 URL 均为固定常量，不拼用户输入（SSRF 约束见 lib/url-security.ts）。
 */

import { randomUUID } from "node:crypto";

const QUARK_CAS_HOST = "https://uop.quark.cn";
const QUARK_CAS_CLIENT_ID = "532";
const QUARK_CAS_V = "1.2";
/**
 * 二维码内容模板（对齐 quarkdownloaderpro 实测可用版）：
 * 只有裸 ?token= 时夸克 App 会报「登录请求过期」——必须带
 * client_id / ssb=weblogin / uc_biz_str 才能被 App 识别为登录授权码。
 */
const QUARK_QR_URL_TEMPLATE =
  "https://su.quark.cn/4_eMHBJ?token={token}&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=" +
  encodeURIComponent("S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0");
const QUARK_PAN_HOST = "https://pan.quark.cn";
const QUARK_DRIVE_HOST = "https://drive-pc.quark.cn";
const QUARK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 20_000;

export interface QuarkQrStart {
  token: string;
  requestId: string;
  /** 二维码编码内容（su.quark.cn 短链），前端负责渲染 */
  qrText: string;
  /** 二维码有效期（毫秒），过期后需重新 qr_start */
  expiresInMs: number;
}

export type QuarkQrPollResult =
  | { status: "pending" }
  | { status: "expired"; message: string }
  | { status: "ok"; cookie: string; nickname?: string };

function casHeaders(cookie?: string): HeadersInit {
  return {
    accept: "application/json, text/plain, */*",
    referer: "https://pan.quark.cn/",
    "user-agent": QUARK_UA,
    ...(cookie ? { cookie } : {}),
  };
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isOk(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === 2000000
  );
}

function extractStringByKeys(payload: unknown, keys: string[]): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** 步骤 1：获取扫码 token（requestId 由调用方生成并全程透传） */
export async function startQuarkQrLogin(
  requestId: string
): Promise<QuarkQrStart> {
  const url = new URL(`${QUARK_CAS_HOST}/cas/ajax/getTokenForQrcodeLogin`);
  url.searchParams.set("client_id", QUARK_CAS_CLIENT_ID);
  url.searchParams.set("v", QUARK_CAS_V);
  url.searchParams.set("request_id", requestId);
  const payload = await fetchJson(url.toString(), {
    headers: casHeaders(),
  });
  if (!isOk(payload)) {
    throw new Error("夸克扫码 token 获取失败，请稍后重试或改用 Cookie 登录");
  }
  const data = (payload as { data?: { members?: { token?: unknown } } }).data;
  const token = typeof data?.members?.token === "string" ? data.members.token : "";
  if (!token) {
    throw new Error("夸克扫码 token 响应格式异常，请稍后重试");
  }
  return {
    token,
    requestId,
    qrText: QUARK_QR_URL_TEMPLATE.replace("{token}", token),
    expiresInMs: 120_000,
  };
}

/** 步骤 2 + 3：轮询扫码状态；确认后用 ticket 换完整 cookie */
export async function pollQuarkQrLogin(token: string): Promise<QuarkQrPollResult> {
  // 每次轮询用独立 request_id（xiaoya-alist / quarkdownloaderpro 同款做法）
  const requestId = randomUUID();
  const url = new URL(`${QUARK_CAS_HOST}/cas/ajax/getServiceTicketByQrcodeToken`);
  url.searchParams.set("client_id", QUARK_CAS_CLIENT_ID);
  url.searchParams.set("v", QUARK_CAS_V);
  url.searchParams.set("request_id", requestId);
  url.searchParams.set("token", token);
  const payload = await fetchJson(url.toString(), { headers: casHeaders() });
  if (!isOk(payload)) {
    // 50004001=等待扫码；50004002=二维码无效/已过期（xiaoya-alist 实测语义）。
    // 其余未知状态按 pending 处理并落日志，便于后续对齐新状态码
    const status = (payload as { status?: unknown })?.status;
    const message =
      typeof (payload as { message?: unknown })?.message === "string"
        ? (payload as { message: string }).message
        : "";
    if (status === 50004002) {
      return { status: "expired", message: message || "二维码无效或已过期" };
    }
    if (status !== 50004001) {
      console.warn(`[qr-login] 轮询未知状态 ${String(status)}: ${message}`);
    }
    return { status: "pending" };
  }
  const data = (payload as { data?: Record<string, unknown> }).data || {};
  // service_ticket 实测在 data.members 下（xiaoya-alist 同款），顶层兜底
  const members =
    typeof data.members === "object" && data.members !== null
      ? (data.members as Record<string, unknown>)
      : {};
  const ticket =
    extractStringByKeys(members, ["service_ticket", "st"]) ||
    extractStringByKeys(data, ["service_ticket", "st"]);
  if (!ticket) {
    console.error(
      "[qr-login] 扫码已确认但未找到 service_ticket，原始响应:",
      JSON.stringify(payload).slice(0, 300)
    );
    return { status: "pending" };
  }

  const cookie = await exchangeQrTicketForCookie(ticket);
  const nickname = await probeQuarkNickname(cookie);
  return { status: "ok", cookie, ...(nickname ? { nickname } : {}) };
}

/**
 * ticket 换 cookie（对齐 xiaoya-alist / quarkdownloaderpro 实测流程）：
 * ticket 以 query 参数 st + lw=scan 访问 account/info 建立登录态，
 * 再依次访问 config / file-sort / member 补全 __puus 等下载必需字段。
 * ticket 是一次性的，步骤失败要兜住尽量收齐 cookie，不能把票弄丢。
 */
async function exchangeQrTicketForCookie(ticket: string): Promise<string> {
  const jar = new Map<string, string>();

  const absorb = (response: Response) => {
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name && value) jar.set(name, value);
    }
  };
  const cookieHeader = () =>
    [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  // 建立登录态：失败重试一次（ticket 一次性，丢了整个扫码流程作废）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const step1 = await fetch(
        `${QUARK_PAN_HOST}/account/info?st=${encodeURIComponent(ticket)}&lw=scan`,
        { headers: casHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      );
      absorb(step1);
      break;
    } catch (error) {
      console.warn(
        "[qr-login] account/info 换取登录态失败:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  if (!jar.has("ucticket")) jar.set("ucticket", ticket);

  // 逐步补全（尤其 __puus，缺它下载/转存会受限），凑齐即提前结束
  const puusSteps = [
    `${QUARK_DRIVE_HOST}/1/clouddrive/config?pr=ucpro&fr=pc&uc_param_str=`,
    `${QUARK_DRIVE_HOST}/1/clouddrive/file/sort?pr=ucpro&fr=pc&uc_param_str=&pdir_fid=0&_page=1&_size=50&_fetch_total=1&_sort=file_type:asc,updated_at:desc`,
    "https://drive.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&uc_param_str=&fetch_subscribe=true",
  ];
  for (const stepUrl of puusSteps) {
    if (cookieHeader().includes("__puus=")) break;
    try {
      const stepResponse = await fetch(stepUrl, {
        headers: casHeaders(cookieHeader()),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      absorb(stepResponse);
    } catch {
      // 补全是尽力而为，单步失败继续下一步
    }
  }

  return cookieHeader();
}

/** 探测账号昵称（仅展示用；失败不阻塞登录） */
export async function probeQuarkNickname(cookie: string): Promise<string | undefined> {
  try {
    const payload = await fetchJson(`${QUARK_PAN_HOST}/account/info`, {
      headers: casHeaders(cookie),
    });
    const data = (payload as { data?: Record<string, unknown> })?.data;
    let nickname =
      typeof data?.nickname === "string"
        ? data.nickname
        : extractStringByKeys(data, ["nickname"]);
    if (!nickname && typeof data?.data === "object" && data.data !== null) {
      nickname = extractStringByKeys(data.data, ["nickname"]);
    }
    return nickname || undefined;
  } catch {
    return undefined;
  }
}
