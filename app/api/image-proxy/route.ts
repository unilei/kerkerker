import { NextRequest, NextResponse } from 'next/server';

import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from '@/lib/url-security';

// 代理池配置
const PROXY_POOL = [
  {
    name: 'wsrv.nl',
    url: (imgUrl: string) => `https://wsrv.nl/?url=${encodeURIComponent(imgUrl)}&output=webp&q=85`,
    timeout: 8000,
  },
  {
    name: 'wsrv.nl',
    url: (imgUrl: string) => `https://wsrv.nl/?url=${encodeURIComponent(imgUrl)}&output=webp&q=100`,
    timeout: 8000,
  } 
];

function isImageResponse(response: Response): boolean {
  return response.ok && (response.headers.get('content-type') || '').toLowerCase().startsWith('image/');
}

async function fetchCandidate(url: string, timeout: number, headers: HeadersInit = {}): Promise<Response> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeout),
  });
  if (isImageResponse(response)) return response;
  await response.body?.cancel().catch(() => undefined);
  throw new Error(`image upstream returned ${response.status}`);
}

/**
 * 使用代理池获取图片
 * 策略：依次尝试代理池中的所有代理，快速失败，提高效率
 */
async function fetchImageWithProxy(url: string): Promise<Response> {
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };

  // TMDB's image CDN is reachable from the deployment region in most cases.
  // Race it with the configured proxies so a slow/broken proxy cannot turn a
  // valid image into the UI placeholder, while retaining a fallback for
  // regions where the CDN is blocked.
  const direct = fetchCandidate(url, 8_000, browserHeaders);
  const proxyAttempts = PROXY_POOL.map((proxy) =>
    fetchCandidate(proxy.url(url), proxy.timeout, browserHeaders)
  );
  try {
    return await Promise.any([direct, ...proxyAttempts]);
  } catch {
    throw new Error('所有获取方式都失败');
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl.searchParams.get('url');
    
    if (!url) {
      return NextResponse.json({ error: 'URL parameter is required' }, { status: 400 });
    }

    const safeUrl = await assertSafeOutboundUrl(url);

    // 使用代理池获取图片
    const response = await fetchImageWithProxy(safeUrl.toString());
    
    const imageBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    return new NextResponse(imageBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Image proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch image' }, { status: 500 });
  }
}
