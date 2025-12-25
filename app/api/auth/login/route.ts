import { NextRequest, NextResponse } from 'next/server';
import { createSession, validatePassword } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();

    if (!password) {
      return NextResponse.json(
        { error: '请输入密码' },
        { status: 400 }
      );
    }

    // 验证密码
    if (!validatePassword(password)) {
      return NextResponse.json(
        { error: '密码错误' },
        { status: 401 }
      );
    }

    // 创建会话
    await createSession();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: '登录失败' },
      { status: 500 }
    );
  }
}
