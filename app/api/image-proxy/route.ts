import { NextRequest, NextResponse } from 'next/server';

// 代理池配置
const PROXY_POOL = [
  {
    name: 'wsrv.nl',
    url: (imgUrl: string) => `https://wsrv.link0.me/?url=${encodeURIComponent(imgUrl)}&output=webp&q=85`,
    timeout: 8000,
  },
  {
    name: 'wsrv.nl',
    url: (imgUrl: string) => `https://wsrv.link0.me/?url=${encodeURIComponent(imgUrl)}&output=webp&q=100`,
    timeout: 8000,
  } 
];

// 延迟函数
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 使用代理池获取图片
 * 策略：依次尝试代理池中的所有代理，快速失败，提高效率
 */
async function fetchImageWithProxy(url: string): Promise<Response> {
  
  const fastProxies = PROXY_POOL.slice(0, 2);
  
  const fastPromises = fastProxies.map(async (proxy) => {
    try {
      const proxyUrl = proxy.url(url);
      const response = await fetch(proxyUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(proxy.timeout),
      });

      if (response.ok) {
        console.log(`✓ ${proxy.name} 成功`);
        return response;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.log(`✗ ${proxy.name} 失败`);
      throw error;
    }
  });

  // 使用 Promise.any，只要有一个成功就返回
  try {
    return await Promise.any(fastPromises);
  } catch {
    console.log('⚠ 前2个代理都失败，尝试剩余代理...');
  }

  // 策略 2: 如果前2个都失败，依次尝试剩余代理
  const remainingProxies = PROXY_POOL.slice(2);
  for (const proxy of remainingProxies) {
    try {
      const proxyUrl = proxy.url(url);
      
      const response = await fetch(proxyUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(proxy.timeout),
      });

      if (response.ok) {
        console.log(`✓ ${proxy.name} 成功`);
        return response;
      }
    } catch {
      console.log(`✗ ${proxy.name} 失败`);
    }
    
    await delay(500); // 短暂延迟
  }

  // 策略 3: 所有代理都失败，尝试直接访问
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://movie.douban.com/',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (response.ok) {
    return response;
  }

  throw new Error('所有获取方式都失败');
}

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl.searchParams.get('url');
    
    if (!url) {
      return NextResponse.json({ error: 'URL parameter is required' }, { status: 400 });
    }

    // 使用代理池获取图片
    const response = await fetchImageWithProxy(url);
    
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
    console.error('Image proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch image' }, { status: 500 });
  }
}
