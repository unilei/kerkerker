import { cookies } from 'next/headers';

// 默认管理员密码（实际使用中应该从环境变量读取）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_COOKIE_NAME = 'admin_session';

// 创建会话
export async function createSession(): Promise<void> {
  const cookieStore = await cookies();
  // 设置session cookie，有效期7天
  cookieStore.set(SESSION_COOKIE_NAME, 'authenticated', {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
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
  return session?.value === 'authenticated';
}

// 验证密码
export function validatePassword(password: string): boolean {
  return password === ADMIN_PASSWORD;
}
