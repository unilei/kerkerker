import { NextRequest, NextResponse } from 'next/server';
import { VodSource } from '@/types/drama';

interface ParseResponse {
  code: number;
  msg: string;
  url: string;
}

// 生成随机 token（32位十六进制字符串）
function generateRandomToken(): string {
  const chars = '0123456789abcdef';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * 16)];
  }
  return token;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, source } = body as { url: string; source: VodSource };

    if (!url) {
      return NextResponse.json(
        { code: 400, msg: '缺少视频URL', data: null },
        { status: 400 }
      );
    }

    // 如果没有解析代理，直接返回原始URL
    if (!source?.parseProxy) {
      return NextResponse.json({
        code: 200,
        msg: 'success',
        data: { url },
      });
    }

    // 构建解析请求URL
    const parseParams = new URLSearchParams();
    if (source.parseId) {
      parseParams.set('id', source.parseId);
    }
    parseParams.set('url', url);
    // 使用随机 token（每次请求生成新的）
    parseParams.set('token', generateRandomToken());

    const parseUrl = `${source.parseProxy}?${parseParams.toString()}`;

    // 从 parseProxy URL 提取 origin 用于 Referer 和 Origin 头
    const parseOrigin = new URL(source.parseProxy).origin;

    // 调用解析API
    const response = await fetch(parseUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
        'Referer': `${parseOrigin}/`,
        'Origin': parseOrigin,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      // 不抛出错误，返回正常响应但带有错误码
      console.warn(`[Parse API] 解析请求失败: HTTP ${response.status}`);
      return NextResponse.json({
        code: response.status,
        msg: `解析API请求失败: HTTP ${response.status}`,
        data: null,
      });
    }

    const data: ParseResponse = await response.json();

    if (data.code !== 200 || !data.url) {
      // 解析服务返回错误，正常返回错误信息
      const errorMsg = data.msg || 'url字段为空或格式错误';
      console.warn(`[Parse API] 解析失败: ${errorMsg}`);
      return NextResponse.json({
        code: 400,
        msg: errorMsg,
        data: null,
      });
    }

    // 处理URL格式（移除转义的斜杠）
    const parsedUrl = data.url.replace(/\\\//g, '/');

    return NextResponse.json({
      code: 200,
      msg: 'success',
      data: { url: parsedUrl },
    });
  } catch (error) {
    // 仅在开发模式下用 warn 输出，避免触发 Next.js 错误覆盖层
    console.warn('[Parse API] 请求异常:', error instanceof Error ? error.message : error);
    return NextResponse.json({
      code: 500,
      msg: error instanceof Error ? error.message : '解析请求异常',
      data: null,
    });
  }
}
