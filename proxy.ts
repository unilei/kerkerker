import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME, validateSessionToken } from '@/lib/auth';

export function proxy(request: NextRequest) {
  // 检查是否访问admin路径
  if (request.nextUrl.pathname.startsWith('/admin')) {
    // 检查session cookie
    const session = request.cookies.get(SESSION_COOKIE_NAME);

    if (!validateSessionToken(session?.value)) {
      // 未登录，重定向到登录页
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set(
        'redirect',
        `${request.nextUrl.pathname}${request.nextUrl.search}`
      );
      return NextResponse.redirect(loginUrl);
    }
  }

  // 旧标签筛选链接永久重定向到独立标签落地页（SEO 权重归一）
  if (request.nextUrl.pathname === '/') {
    const tag = request.nextUrl.searchParams.get('tag');
    if (tag) {
      const target = new URL(`/tags/${encodeURIComponent(tag)}`, request.url);
      // 保留 search 词时降级到首页（search+tag 组合落地页不支持，搜索语义优先）
      const search = request.nextUrl.searchParams.get('search');
      if (search) {
        target.search = '';
        return NextResponse.redirect(new URL(`/?search=${encodeURIComponent(search)}`, request.url), 301);
      }
      return NextResponse.redirect(target, 301);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/'],
};
