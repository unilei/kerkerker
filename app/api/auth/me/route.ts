import { NextRequest, NextResponse } from 'next/server';
import { validateRequestSession } from '@/lib/auth';

// GET - 探测当前会话是否为已登录管理员
// 前台详情页据此决定是否展示「网盘资源管理」入口，仅返回布尔值，无敏感信息
export async function GET(request: NextRequest) {
  const authenticated = validateRequestSession(request);

  return NextResponse.json({
    code: 200,
    message: 'ok',
    data: { authenticated },
  });
}
