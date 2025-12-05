/**
 * 豆瓣API请求客户端
 * 
 * 使用 Cloudflare Workers 代理解决IP限制问题
 * 支持多代理负载均衡，用逗号分隔多个URL
 * 配置: DOUBAN_API_PROXY=https://proxy1.workers.dev,https://proxy2.workers.dev
 */

// 解析多个代理地址
const DOUBAN_API_PROXIES = (process.env.DOUBAN_API_PROXY || '')
  .split(',')
  .map(url => url.trim())
  .filter(url => url.length > 0);

// 随机选择一个代理
function getRandomProxy(): string | null {
  if (DOUBAN_API_PROXIES.length === 0) return null;
  return DOUBAN_API_PROXIES[Math.floor(Math.random() * DOUBAN_API_PROXIES.length)];
}

// 随机User-Agent池
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
];

// 获取随机User-Agent
function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 请求配置
interface DoubanFetchOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

const DEFAULT_OPTIONS: Required<DoubanFetchOptions> = {
  timeout: 10000,
  retries: 3,
  retryDelay: 1000,
};

// 延迟函数
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 构建请求头
function buildHeaders(): HeadersInit {
  return {
    'User-Agent': getRandomUserAgent(),
    'Referer': 'https://movie.douban.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };
}

/**
 * 将豆瓣URL转换为代理URL（随机选择一个代理）
 * 支持 movie.douban.com 和 api.douban.com
 */
function convertToProxyUrl(originalUrl: string): { url: string; proxy: string | null } {
  const proxy = getRandomProxy();
  if (!proxy) return { url: originalUrl, proxy: null };
  
  try {
    const url = new URL(originalUrl);
    // 支持 movie.douban.com 和 api.douban.com
    if (!url.hostname.includes('douban.com')) return { url: originalUrl, proxy: null };
    
    // 使用随机选择的代理，直接使用路径+查询参数
    return { 
      url: `${proxy}${url.pathname}${url.search}`,
      proxy 
    };
  } catch {
    return { url: originalUrl, proxy: null };
  }
}

/**
 * 豆瓣API请求函数
 * 通过 Cloudflare Workers 代理请求（随机负载均衡）
 */
export async function doubanFetch(
  url: string,
  options: DoubanFetchOptions = {}
): Promise<Response> {
  const { timeout, retries, retryDelay } = { ...DEFAULT_OPTIONS, ...options };
  
  // 使用随机选择的 Cloudflare Workers 代理
  const { url: finalUrl, proxy } = convertToProxyUrl(url);
  const useProxy = proxy !== null;
  
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    // 每次重试可能使用不同的代理
    const currentUrl = attempt === 1 ? finalUrl : convertToProxyUrl(url).url;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const fetchOptions: RequestInit = {
        method: 'GET',
        headers: useProxy ? {} : buildHeaders(),
        signal: controller.signal,
      };
      
      const response = await fetch(currentUrl, fetchOptions);
      clearTimeout(timeoutId);
      
      // 如果是403/429，触发重试
      if (response.status === 403 || response.status === 429) {
        const errorMsg = `HTTP ${response.status}: ${response.statusText}`;
        console.warn(`⚠️ 豆瓣请求被限制 (尝试 ${attempt}/${retries}): ${errorMsg}`);
        lastError = new Error(errorMsg);
        
        if (attempt < retries) {
          // 指数退避重试
          const waitTime = retryDelay * Math.pow(2, attempt - 1);
          console.log(`⏳ 等待 ${waitTime}ms 后重试...`);
          await delay(waitTime);
          continue;
        }
        
        throw lastError;
      }
      
      return response;
      
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < retries) {
        console.warn(`⚠️ 豆瓣请求失败 (尝试 ${attempt}/${retries}):`, lastError.message);
        const waitTime = retryDelay * Math.pow(2, attempt - 1);
        await delay(waitTime);
        continue;
      }
    }
  }
  
  throw lastError || new Error('请求失败');
}

/**
 * 豆瓣搜索API
 */
export async function doubanSearchSubjects(params: {
  type?: string;
  tag: string;
  page_limit?: number;
  page_start?: number;
}): Promise<{ subjects: DoubanSubject[] }> {
  const url = new URL('https://movie.douban.com/j/search_subjects');
  url.searchParams.append('type', params.type || '');
  url.searchParams.append('tag', params.tag);
  url.searchParams.append('page_limit', String(params.page_limit || 20));
  url.searchParams.append('page_start', String(params.page_start || 0));
  
  const response = await doubanFetch(url.toString());
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * 豆瓣电影简要详情API（旧接口，不返回封面）
 */
export async function doubanSubjectAbstract(subjectId: string): Promise<DoubanSubjectDetail> {
  const url = `https://movie.douban.com/j/subject_abstract?subject_id=${subjectId}`;
  
  const response = await doubanFetch(url, { timeout: 5000 });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * 豆瓣搜索建议API（可获取封面）
 * https://movie.douban.com/j/subject_suggest?q=关键词
 */
export interface DoubanSuggestItem {
  id: string;
  title: string;
  sub_title?: string;
  img: string;
  url: string;
  type: string;
  year?: string;
  episode?: string;
}

export async function doubanSubjectSuggest(query: string): Promise<DoubanSuggestItem[]> {
  const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`;
  
  try {
    const response = await doubanFetch(url, { timeout: 5000 });
    
    if (!response.ok) {
      console.warn(`豆瓣搜索建议API返回 ${response.status}`);
      return [];
    }
    
    return response.json();
  } catch (error) {
    console.warn('豆瓣搜索建议API请求失败:', error);
    return [];
  }
}

/**
 * 豆瓣新片榜API
 */
export async function doubanNewMovies(): Promise<DoubanSubject[]> {
  const url = 'https://movie.douban.com/j/new_search_subjects?sort=U&range=0,10&tags=电影&start=0&genres=&year_range=2024,2025';
  
  const response = await doubanFetch(url);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data || [];
}

// 类型定义
export interface DoubanSubject {
  id: string;
  title: string;
  rate: string;
  cover: string;
  url: string;
  episode_info?: string;
}

export interface DoubanSubjectDetail {
  subject?: {
    id: string;
    title: string;
    rate: string;
    url: string;
    // 注意：/j/subject_abstract API 不返回 cover
    types?: string[];
    release_year?: string;
    directors?: string[];
    actors?: string[];
    duration?: string;
    region?: string;
    episodes_count?: string;
    short_comment?: {
      content: string;
      author: string;
    };
  };
}

/**
 * 检查代理状态
 */
export function getProxyStatus(): { enabled: boolean; count: number; urls: string[] } {
  return {
    enabled: DOUBAN_API_PROXIES.length > 0,
    count: DOUBAN_API_PROXIES.length,
    urls: DOUBAN_API_PROXIES,
  };
}
