// 视频代理API - 处理CORS和代理视频流
import { NextRequest, NextResponse } from 'next/server';

import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from '@/lib/url-security';

// 使用Node.js Runtime以支持完整的URL处理
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ segments: string[] }> }
) {
  let targetUrl = '';

  try {
    // Next.js 15+ params 是 Promise，需要 await
    const resolvedParams = await params;

    // 重建目标URL
    targetUrl = decodeURIComponent(resolvedParams.segments.join('/'));

    console.log('🔄 代理请求 segments:', resolvedParams.segments);
    console.log('🔄 代理请求 targetUrl:', targetUrl);

    try {
      targetUrl = (await assertSafeOutboundUrl(targetUrl)).toString();
    } catch (error) {
      if (error instanceof UnsafeOutboundUrlError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }

      return NextResponse.json(
        { error: '无效的URL' },
        { status: 400 }
      );
    }

    // 获取客户端的Range header
    const rangeHeader = request.headers.get('Range');

    // 准备请求头 - 尝试多种策略
    const strategies = [
      // 策略1: 极简headers（避免被识别为代理）
      () => {
        const headers: HeadersInit = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };
        if (rangeHeader) headers['Range'] = rangeHeader;
        return headers;
      },
      // 策略2: 添加Referer但不设置Origin
      () => {
        const headers: HeadersInit = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
        };
        try {
          const urlObj = new URL(targetUrl);
          headers['Referer'] = `${urlObj.protocol}//${urlObj.host}/`;
        } catch (e) {
          console.warn('设置Referer失败:', e);
        }
        if (rangeHeader) headers['Range'] = rangeHeader;
        return headers;
      },
      // 策略3: 完整的浏览器headers
      () => {
        const headers: HeadersInit = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        };
        try {
          const urlObj = new URL(targetUrl);
          headers['Referer'] = `${urlObj.protocol}//${urlObj.host}/`;
          headers['Origin'] = `${urlObj.protocol}//${urlObj.host}`;
        } catch (e) {
          console.warn('设置Referer失败:', e);
        }
        if (rangeHeader) headers['Range'] = rangeHeader;
        return headers;
      },
    ];

    // 尝试第一个策略
    let fetchHeaders = strategies[0]();
    console.log('🔧 请求headers (策略1):', JSON.stringify(fetchHeaders, null, 2));

    let response: Response | null = null;
    let lastError: Error | null = null;

    // 尝试所有策略
    for (let i = 0; i < strategies.length; i++) {
      try {
        if (i > 0) {
          console.log(`⚠️ 策略${i}失败，尝试策略${i + 1}...`);
          fetchHeaders = strategies[i]();
          console.log(`🔧 请求headers (策略${i + 1}):`, JSON.stringify(fetchHeaders, null, 2));
        }

        // 转发请求
        response = await fetch(targetUrl, {
          headers: fetchHeaders,
          redirect: 'manual',
          // 🚀 减少超时时间，快速失败（从30秒改为8秒）
          signal: AbortSignal.timeout(8000),
        });

        // 如果成功或者不是403/5xx错误，跳出循环
        if (response.ok || response.status === 206 || (response.status < 403 && response.status >= 300)) {
          break;
        }

        // 如果是403或5xx错误且还有其他策略，继续尝试
        if (i < strategies.length - 1) {
          continue;
        }

      } catch (error) {
        lastError = error as Error;
        console.error(`❌ 策略${i + 1}网络请求失败:`, error);

        // 如果是最后一个策略，抛出错误
        if (i === strategies.length - 1) {
          throw error;
        }
        // 否则继续尝试下一个策略
        continue;
      }
    }

    // 如果所有策略都失败
    if (!response) {
      throw lastError || new Error('所有请求策略失败');
    }

    // 处理重定向
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (location) {
        // 返回重定向地址
        return NextResponse.redirect(location);
      }
    }

    // 检查响应状态
    if (!response.ok && response.status !== 206) {
      console.error('❌ 代理请求失败:', response.status, response.statusText);
      console.error('❌ 目标URL:', targetUrl);
      console.error('❌ 响应headers:', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

      // 尝试读取错误响应体
      try {
        const errorText = await response.text();
        console.error('❌ 错误响应内容:', errorText.substring(0, 500));
      } catch (e) {
        console.error('❌ 无法读取错误响应:', e);
      }

      // 如果是403，可能是IP封锁，返回原始URL供前端直接请求
      if (response.status === 403) {
        console.log('🔄 所有代理策略失败，可能是IP封锁，返回原始URL');
        return NextResponse.json(
          {
            error: 'proxy_blocked',
            message: '代理服务器被IP封锁，尝试直接播放',
            fallbackUrl: targetUrl,
            useDirect: true,
          },
          {
            status: 403,
            headers: {
              'X-Proxy-Status': 'blocked',
              'X-Fallback-Url': encodeURIComponent(targetUrl),
            }
          }
        );
      }

      return NextResponse.json(
        {
          error: `代理请求失败: ${response.status} ${response.statusText}`,
          url: targetUrl,
          suggestion: '目标站点拒绝访问，可能需要特定的cookies或认证'
        },
        { status: response.status }
      );
    }

    // 获取响应内容类型
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

    console.log('📌 Content-Type:', contentType);
    console.log('📌 targetUrl:', targetUrl);
    console.log('📌 是否m3u8:', targetUrl.endsWith('.m3u8'));

    // 先处理m3u8文件（优先级最高）
    if (contentType.includes('mpegurl') || contentType.includes('m3u8') || targetUrl.endsWith('.m3u8')) {
      console.log('✅ 开始处理m3u8文件');
      const text = await response.text();
      console.log('📄 原始m3u8内容 (前200字符):', text.substring(0, 200));

      // 处理m3u8中的相对路径
      const processedM3u8 = processM3u8Content(text, targetUrl);
      console.log('📄 处理后m3u8内容 (前200字符):', processedM3u8.substring(0, 200));

      return new NextResponse(processedM3u8, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 对于视频流和其他内容，直接转发（支持Range请求）
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        ...(response.headers.get('Content-Range') && {
          'Content-Range': response.headers.get('Content-Range') || '',
        }),
        ...(response.headers.get('Content-Length') && {
          'Content-Length': response.headers.get('Content-Length') || '',
        }),
        ...(response.headers.get('Accept-Ranges') && {
          'Accept-Ranges': response.headers.get('Accept-Ranges') || '',
        }),
      },
    });

  } catch (error) {
    console.error('❌ 代理错误:', error);

    // 解析错误类型
    const err = error as Error;
    let errorMessage = '代理请求失败';
    let errorCode = 'PROXY_ERROR';
    let suggestion = '';

    if (err.message) {
      // TLS/SSL 错误
      if (err.message.includes('ECONNRESET') || err.message.includes('socket disconnected')) {
        errorMessage = 'TLS连接被重置，目标服务器拒绝连接';
        errorCode = 'TLS_CONNECTION_RESET';
        suggestion = '该服务器可能使用了非标准端口或证书配置，建议切换其他视频源';
      }
      // 超时错误
      else if (err.message.includes('timeout') || err.message.includes('aborted')) {
        errorMessage = '请求超时，服务器响应过慢';
        errorCode = 'REQUEST_TIMEOUT';
        suggestion = '网络连接不稳定或服务器繁忙，建议稍后重试';
      }
      // DNS 错误
      else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
        errorMessage = '无法解析域名，服务器不存在';
        errorCode = 'DNS_ERROR';
        suggestion = '该视频源可能已失效，建议切换其他源';
      }
      // 连接拒绝
      else if (err.message.includes('ECONNREFUSED')) {
        errorMessage = '连接被拒绝，服务器未响应';
        errorCode = 'CONNECTION_REFUSED';
        suggestion = '目标服务器可能已下线，建议切换其他源';
      }
      // 其他网络错误
      else if (err.message.includes('fetch failed')) {
        errorMessage = '网络请求失败';
        errorCode = 'NETWORK_ERROR';
        suggestion = '请检查网络连接或尝试切换其他视频源';
      }
    }

    console.error('📋 错误详情:', {
      code: errorCode,
      message: errorMessage,
      original: err.message,
      url: targetUrl,
    });

    return NextResponse.json(
      {
        error: errorCode,
        message: errorMessage,
        details: err.message,
        suggestion,
        url: targetUrl,
        fallbackUrl: targetUrl,
        useDirect: true, // 建议前端尝试直接播放
      },
      {
        status: 500,
        headers: {
          'X-Error-Code': errorCode,
          'X-Fallback-Url': encodeURIComponent(targetUrl),
        }
      }
    );
  }
}

// OPTIONS请求处理（CORS预检）
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// 处理m3u8内容，转换相对路径为代理路径
function processM3u8Content(content: string, baseUrl: string): string {
  const lines = content.split('\n');
  const base = new URL(baseUrl);

  console.log('📝 processM3u8Content baseUrl:', baseUrl);
  console.log('📝 processM3u8Content base.href:', base.href);

  // 辅助函数：解析并代理URL
  const resolveAndProxy = (urlString: string): string => {
    try {
      let url: URL;
      if (urlString.startsWith('http://') || urlString.startsWith('https://')) {
        url = new URL(urlString);
      } else {
        url = new URL(urlString, base.href);
      }
      return `/api/video-proxy/${encodeURIComponent(url.href)}`;
    } catch (e) {
      console.error(`❌ URL解析失败: "${urlString}"`, e);
      return urlString;
    }
  };

  const processedLines = lines.map(line => {
    // 处理 #EXT-X-KEY 标签中的 URI（加密密钥）
    if (line.startsWith('#EXT-X-KEY:')) {
      const uriMatch = line.match(/URI=["']?([^"',]+)["']?/);
      if (uriMatch && uriMatch[1]) {
        const originalUri = uriMatch[1];
        const proxiedUri = resolveAndProxy(originalUri);
        console.log(`🔑 密钥URI: "${originalUri}" => "${proxiedUri}"`);
        return line.replace(/URI=["']?[^"',]+["']?/, `URI="${proxiedUri}"`);
      }
      return line;
    }

    // 跳过其他注释行和空行
    if (line.startsWith('#') || !line.trim()) {
      return line;
    }

    // 处理片段URL
    const trimmedLine = line.trim();
    const proxiedUrl = resolveAndProxy(trimmedLine);
    console.log(`📝 片段: "${trimmedLine}" => "${proxiedUrl}"`);
    return proxiedUrl;
  });

  return processedLines.join('\n');
}
