import { createHmac, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

// Session cookie 名称
export const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_TOKEN_VERSION = 'v1';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

interface SessionTokenOptions {
  secret?: string;
  now?: number;
  maxAge?: number;
}

// 获取管理员密码（运行时动态读取环境变量，避免构建时被内联）
function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD || 'admin123';
}

function getSessionSecret(): string {
  return process.env.ADMIN_SESSION_SECRET || getAdminPassword();
}

function signSessionPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}

function getSessionCookieSecureFlag(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function createSessionToken(options: SessionTokenOptions = {}): string {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAge ?? SESSION_MAX_AGE_SECONDS;
  const secret = options.secret ?? getSessionSecret();
  const expiresAt = now + maxAge * 1000;
  const payload = `${SESSION_TOKEN_VERSION}.${expiresAt}`;
  const signature = signSessionPayload(payload, secret);

  return `${payload}.${signature}`;
}

export function validateSessionToken(
  token: string | undefined | null,
  options: Omit<SessionTokenOptions, 'maxAge'> = {}
): boolean {
  if (!token) {
    return false;
  }

  const [version, expiresAtRaw, signature, ...rest] = token.split('.');

  if (rest.length > 0 || version !== SESSION_TOKEN_VERSION || !expiresAtRaw || !signature) {
    return false;
  }

  const expiresAt = Number(expiresAtRaw);
  const now = options.now ?? Date.now();

  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return false;
  }

  const secret = options.secret ?? getSessionSecret();
  const expectedSignature = signSessionPayload(`${version}.${expiresAtRaw}`, secret);

  return safeEqual(signature, expectedSignature);
}

export function validateRequestSession(
  request: Pick<NextRequest, 'cookies'> | undefined
): boolean {
  if (!request) {
    return false;
  }

  return validateSessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

// 创建会话
export async function createSession(): Promise<void> {
  const cookieStore = await cookies();
  // 设置session cookie，有效期7天
  cookieStore.set(SESSION_COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    secure: getSessionCookieSecureFlag(),
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/'
  });
}

// 删除会话
export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

// 验证会话
export async function validateSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE_NAME);
  return validateSessionToken(session?.value);
}

// 验证密码
export function validatePassword(password: string): boolean {
  return password === getAdminPassword();
}
