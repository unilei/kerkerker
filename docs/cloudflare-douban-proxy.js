/**
 * Cloudflare Workers - 豆瓣API代理
 * 
 * 功能特性:
 * - CORS 完整支持（包括 OPTIONS 预检请求）
 * - 响应缓存（减少豆瓣 API 请求频率）
 * - 健康检查接口 /health
 * - 支持 GET/POST 请求
 * 
 * 部署方式:
 * 方式1: 运行 scripts/deploy-douban-proxy.sh 自动部署
 * 方式2: 手动部署到 Cloudflare Dashboard
 *   1. 登录 https://dash.cloudflare.com/
 *   2. 进入 Workers & Pages -> Create Application -> Create Worker
 *   3. 粘贴此代码并部署
 *   4. 在 .env 中设置: DOUBAN_API_PROXY=https://douban-proxy.xxx.workers.dev
 */

// 缓存配置（秒）
const CACHE_TTL = {
  '/j/search_subjects': 300,      // 搜索结果缓存 5 分钟
  '/j/subject_abstract': 3600,    // 影片详情缓存 1 小时
  '/j/subject_suggest': 300,      // 搜索建议缓存 5 分钟
  '/j/new_search_subjects': 300,  // 新片榜缓存 5 分钟
  '/j/search_tags': 86400,        // 搜索标签缓存 24 小时
  '/j/celebrity/': 3600,          // 影人信息缓存 1 小时
  '/j/tv/subject/': 3600,         // 电视剧集信息缓存 1 小时
  '/j/subject/': 1800,            // 短评/推荐/剧照缓存 30 分钟
  '/j/chart/': 600,               // 榜单缓存 10 分钟
  '/v2/': 3600,                   // v2 API 缓存 1 小时
  'default': 60,                  // 默认缓存 1 分钟
};

// CORS 响应头
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',  // 预检请求缓存 24 小时
};

// 随机 User-Agent 池
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

// 允许的豆瓣 API 路径及其对应的域名
const ROUTE_MAP = {
  // Web API (movie.douban.com)
  '/j/search_subjects': 'https://movie.douban.com',
  '/j/subject_abstract': 'https://movie.douban.com',
  '/j/subject_suggest': 'https://movie.douban.com',
  '/j/new_search_subjects': 'https://movie.douban.com',
  '/j/search_tags': 'https://movie.douban.com',
  '/j/celebrity/': 'https://movie.douban.com',
  '/j/tv/subject/': 'https://movie.douban.com',
  '/j/subject/': 'https://movie.douban.com',
  '/j/chart/': 'https://movie.douban.com',
  // Frodo API (api.douban.com)
  '/v2/movie/subject/': 'https://api.douban.com',
  '/v2/movie/search': 'https://api.douban.com',
  '/v2/movie/in_theaters': 'https://api.douban.com',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. 处理 CORS 预检请求
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 2. 健康检查接口
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        routes: Object.keys(ROUTE_MAP),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // 3. 查找匹配的路由
    let targetDomain = null;
    for (const [prefix, domain] of Object.entries(ROUTE_MAP)) {
      if (path.startsWith(prefix)) {
        targetDomain = domain;
        break;
      }
    }

    if (!targetDomain) {
      return new Response(JSON.stringify({ error: 'Path not allowed', path }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // 4. 构建缓存 key（仅对 GET 请求缓存）
    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;

    // 5. 尝试从缓存读取（仅 GET 请求）
    if (method === 'GET') {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        // 添加缓存命中标记
        const headers = new Headers(cachedResponse.headers);
        headers.set('X-Cache', 'HIT');
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          headers,
        });
      }
    }

    // 6. 请求豆瓣 API
    const doubanUrl = targetDomain + path + url.search;
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    try {
      const fetchOptions = {
        method: method === 'POST' ? 'POST' : 'GET',
        headers: {
          'User-Agent': ua,
          'Referer': 'https://movie.douban.com/',
          'Accept': 'application/json',
        },
      };

      // POST 请求转发 body
      if (method === 'POST') {
        fetchOptions.body = await request.text();
        fetchOptions.headers['Content-Type'] = request.headers.get('Content-Type') || 'application/json';
      }

      const resp = await fetch(doubanUrl, fetchOptions);
      const text = await resp.text();

      // 7. 计算缓存 TTL
      let ttl = CACHE_TTL['default'];
      for (const [prefix, cacheTtl] of Object.entries(CACHE_TTL)) {
        if (path.startsWith(prefix)) {
          ttl = cacheTtl;
          break;
        }
      }

      // 8. 构建响应
      const responseHeaders = {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttl}`,
        'X-Cache': 'MISS',
        ...CORS_HEADERS,
      };

      const response = new Response(text, {
        status: resp.status,
        headers: responseHeaders,
      });

      // 9. 写入缓存（仅成功的 GET 请求）
      if (method === 'GET' && resp.status === 200) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  },
};
