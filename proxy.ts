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
  
  return NextResponse.next();
}

export const config = {
  matcher: '/admin/:path*'
};
