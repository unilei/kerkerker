import { NextRequest, NextResponse } from 'next/server';

import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from '@/lib/url-security';

export const dynamic = 'force-dynamic';

/**
 * 智能视频代理 v2
 * 支持 m3u8 播放列表重写
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const videoUrl = searchParams.get('url');
    
    if (!videoUrl) {
      return NextResponse.json(
        { code: 400, message: '缺少视频地址参数' },
        { status: 400 }
      );
    }

    const safeVideoUrl = (await assertSafeOutboundUrl(videoUrl)).toString();

    console.log(`🎬 代理视频请求: ${safeVideoUrl}`);

    // 准备请求头 - 模拟真实浏览器
    const fetchHeaders: HeadersInit = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    };
    
    // 添加 Referer - 使用同域名的根路径
    try {
      const urlObj = new URL(safeVideoUrl);
      fetchHeaders['Referer'] = `${urlObj.protocol}//${urlObj.host}/`;
      fetchHeaders['Origin'] = `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
      console.warn('设置Referer失败:', e);
    }
    
    // 添加 Range 头（如果存在）
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      fetchHeaders['Range'] = rangeHeader;
    }
    
    console.log('🔧 请求headers:', JSON.stringify(fetchHeaders, null, 2));
    
    const videoResponse = await fetch(safeVideoUrl, {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(30000)
    });

    if (!videoResponse.ok && videoResponse.status !== 206) {
      console.error(`❌ 视频请求失败: ${videoResponse.status} ${videoResponse.statusText}`);
      console.error('❌ 目标URL:', safeVideoUrl);
      console.error('❌ 响应headers:', JSON.stringify(Object.fromEntries(videoResponse.headers.entries()), null, 2));
      
      // 尝试读取错误响应体
      try {
        const errorText = await videoResponse.text();
        console.error('❌ 错误响应内容:', errorText.substring(0, 500));
      } catch (e) {
        console.error('❌ 无法读取错误响应:', e);
      }
      
      return NextResponse.json(
        { 
          code: videoResponse.status,
          message: `视频请求失败: ${videoResponse.status} ${videoResponse.statusText}`,
          suggestion: videoResponse.status === 403 ? '目标站点拒绝访问，可能需要特定的cookies或认证' : undefined
        },
        { status: videoResponse.status }
      );
    }

    const contentType = videoResponse.headers.get('content-type') || '';

    // 检查是否是 m3u8 播放列表
    if (contentType.includes('application/vnd.apple.mpegurl') || 
        contentType.includes('application/x-mpegURL') ||
        safeVideoUrl.endsWith('.m3u8')) {
      
      console.log('📝 检测到 m3u8 文件，重写内部 URL...');
      
      // 读取 m3u8 内容
      const m3u8Content = await videoResponse.text();
      
      // 重写 m3u8 内容
      const rewrittenContent = rewriteM3U8(m3u8Content, safeVideoUrl, request.nextUrl.origin);
      
      // 返回重写后的 m3u8
      return new NextResponse(rewrittenContent, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Expose-Headers': 'Content-Length',
          'Cache-Control': 'no-cache',
        }
      });
    }

    // 非 m3u8 文件，直接转发
    const headers = new Headers();
    
    const headersToClone = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
    ];

    headersToClone.forEach(header => {
      const value = videoResponse.headers.get(header);
      if (value) headers.set(header, value);
    });

    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range, Content-Type');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    return new NextResponse(videoResponse.body, {
      status: videoResponse.status,
      headers
    });

  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      return NextResponse.json(
        { code: error.status, message: error.message },
        { status: error.status }
      );
    }

    console.error('视频代理失败:', error);
    return NextResponse.json(
      { code: 500, message: error instanceof Error ? error.message : '视频代理失败' },
      { status: 500 }
    );
  }
}

/**
 * 重写 m3u8 文件内容
 * 将所有资源 URL 替换为代理 URL
 */
function rewriteM3U8(content: string, baseUrl: string, proxyOrigin: string): string {
  const lines = content.split('\n');
  const baseUrlObj = new URL(baseUrl);
  const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  
  // 辅助函数：将相对URL转换为绝对URL
  const resolveUrl = (url: string): string => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    if (url.startsWith('/')) {
      return `${baseUrlObj.protocol}//${baseUrlObj.host}${url}`;
    }
    return baseDir + url;
  };
  
  const rewrittenLines = lines.map(line => {
    // 处理 #EXT-X-KEY 标签中的 URI
    if (line.startsWith('#EXT-X-KEY:')) {
      // 匹配 URI="..." 或 URI='...' 或 URI=...
      const uriMatch = line.match(/URI=["']?([^"',]+)["']?/);
      if (uriMatch && uriMatch[1]) {
        const originalUri = uriMatch[1];
        const absoluteUri = resolveUrl(originalUri);
        const proxiedUri = `${proxyOrigin}/api/video-proxy?url=${encodeURIComponent(absoluteUri)}`;
        // 替换原始URI为代理URI
        return line.replace(/URI=["']?[^"',]+["']?/, `URI="${proxiedUri}"`);
      }
      return line;
    }
    
    // 跳过其他注释行和空行
    if (line.startsWith('#') || line.trim() === '') {
      return line;
    }
    
    // 处理资源 URL（.ts 片段等）
    const resourceUrl = resolveUrl(line.trim());
    const proxiedUrl = `${proxyOrigin}/api/video-proxy?url=${encodeURIComponent(resourceUrl)}`;
    
    return proxiedUrl;
  });
  
  return rewrittenLines.join('\n');
}

export async function OPTIONS() {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  
  return new NextResponse(null, {
    status: 204,
    headers
  });
}
