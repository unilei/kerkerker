import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  // 检查是否访问admin路径
  if (request.nextUrl.pathname.startsWith('/admin')) {
    // 检查session cookie
    const session = request.cookies.get('admin_session');
    
    if (!session || session.value !== 'authenticated') {
      // 未登录，重定向到登录页
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: '/admin/:path*'
};
