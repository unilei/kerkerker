/**
 * 豆瓣API请求客户端
 * 
 * 使用 Cloudflare Workers 代理解决IP限制问题
 * 支持多代理负载均衡，用逗号分隔多个URL
 * 配置: DOUBAN_API_PROXY=https://proxy1.workers.dev,https://proxy2.workers.dev
 * 
 * 支持的API类型:
 * 1. Web API (movie.douban.com/j/...) - 网页版API
 * 2. Frodo API (frodo.douban.com/api/v2/...) - 移动端API，数据更全
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

// 随机User-Agent池 - 更新为2024-2025年最新版本
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
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
 * 豆瓣新片榜API - 更新参数以支持动态年份
 */
export async function doubanNewMovies(params?: {
  sort?: 'U' | 'T' | 'S' | 'R';  // U=近期热门, T=标记最多, S=评分最高, R=最新
  tags?: string;
  genres?: string;
  start?: number;
  limit?: number;
  yearRange?: [number, number];
}): Promise<DoubanNewSearchSubject[]> {
  const currentYear = new Date().getFullYear();
  const {
    sort = 'U',
    tags = '电影',
    genres = '',
    start = 0,
    limit = 20,
    yearRange = [currentYear - 1, currentYear + 1]
  } = params || {};
  
  const url = `https://movie.douban.com/j/new_search_subjects?sort=${sort}&range=0,10&tags=${encodeURIComponent(tags)}&start=${start}&limit=${limit}&genres=${encodeURIComponent(genres)}&year_range=${yearRange[0]},${yearRange[1]}`;
  
  const response = await doubanFetch(url);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data || [];
}

/**
 * 豆瓣高级搜索API - 支持更多筛选条件
 */
export async function doubanAdvancedSearch(params: {
  tags: string;             // 标签：电影、电视剧等
  sort?: 'U' | 'T' | 'S' | 'R';
  range?: string;           // 评分范围 "0,10" 或 "8,10"
  genres?: string;          // 类型：喜剧、动作等
  countries?: string;       // 地区：美国、中国大陆等
  year_range?: string;      // 年份范围 "2020,2024"
  start?: number;
  limit?: number;
}): Promise<{ data: DoubanNewSearchSubject[]; total?: number }> {
  const url = new URL('https://movie.douban.com/j/new_search_subjects');
  url.searchParams.append('sort', params.sort || 'U');
  url.searchParams.append('range', params.range || '0,10');
  url.searchParams.append('tags', params.tags);
  url.searchParams.append('start', String(params.start || 0));
  url.searchParams.append('limit', String(params.limit || 20));
  
  if (params.genres) url.searchParams.append('genres', params.genres);
  if (params.countries) url.searchParams.append('countries', params.countries);
  if (params.year_range) url.searchParams.append('year_range', params.year_range);
  
  const response = await doubanFetch(url.toString());
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * 获取可用的搜索标签
 */
export async function doubanSearchTags(type: 'movie' | 'tv'): Promise<string[]> {
  const url = `https://movie.douban.com/j/search_tags?type=${type}`;
  
  const response = await doubanFetch(url, { timeout: 5000 });
  
  if (!response.ok) {
    return [];
  }
  
  const data = await response.json();
  return data.tags || [];
}

/**
 * 豆瓣影人信息API
 */
export async function doubanCelebrity(celebrityId: string): Promise<DoubanCelebrity | null> {
  const url = `https://movie.douban.com/j/celebrity/${celebrityId}/info`;
  
  try {
    const response = await doubanFetch(url, { timeout: 5000 });
    
    if (!response.ok) {
      return null;
    }
    
    return response.json();
  } catch {
    return null;
  }
}

/**
 * 豆瓣电视剧集信息API
 */
export async function doubanTvEpisodes(subjectId: string): Promise<DoubanEpisode[]> {
  const url = `https://movie.douban.com/j/tv/subject/${subjectId}/episode`;
  
  try {
    const response = await doubanFetch(url, { timeout: 5000 });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    return data.episodes || [];
  } catch {
    return [];
  }
}

/**
 * 获取影片短评
 */
export async function doubanComments(subjectId: string, params?: {
  start?: number;
  limit?: number;
  sort?: 'new_score' | 'time';
  status?: 'P' | 'F';  // P=看过, F=想看
}): Promise<DoubanComment[]> {
  const { start = 0, limit = 20, sort = 'new_score', status = 'P' } = params || {};
  
  const url = `https://movie.douban.com/j/subject/${subjectId}/comments?start=${start}&limit=${limit}&sort=${sort}&status=${status}`;
  
  try {
    const response = await doubanFetch(url, { timeout: 8000 });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    return data.comments || [];
  } catch {
    return [];
  }
}

/**
 * 豆瓣榜单API - 获取各类榜单
 */
export async function doubanChart(chartType: 
  'movie_weekly_best' |      // 一周口碑榜 - 电影
  'movie_real_time_hotest' | // 实时热门 - 电影  
  'tv_weekly_chinese' |      // 华语口碑剧集榜
  'tv_weekly_global' |       // 全球口碑剧集榜
  'show_chinese' |           // 综艺榜
  'tv_real_time_hotest'      // 实时热门 - 电视
): Promise<DoubanChartSubject[]> {
  const url = `https://movie.douban.com/j/chart/${chartType}`;
  
  try {
    const response = await doubanFetch(url, { timeout: 8000 });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    return data.subjects || data || [];
  } catch {
    return [];
  }
}

/**
 * 获取影片相关推荐
 */
export async function doubanRecommendations(subjectId: string): Promise<DoubanSubject[]> {
  const url = `https://movie.douban.com/j/subject/${subjectId}/recommendations`;
  
  try {
    const response = await doubanFetch(url, { timeout: 5000 });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    return data.recommendations || [];
  } catch {
    return [];
  }
}

/**
 * 获取影片剧照
 */
export async function doubanPhotos(subjectId: string, params?: {
  start?: number;
  count?: number;
  type?: 'S' | 'R' | 'W';  // S=剧照, R=海报, W=壁纸
}): Promise<DoubanPhoto[]> {
  const { start = 0, count = 20, type = 'S' } = params || {};
  
  const url = `https://movie.douban.com/j/subject/${subjectId}/photos?type=${type}&start=${start}&count=${count}`;
  
  try {
    const response = await doubanFetch(url, { timeout: 8000 });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    return data.photos || [];
  } catch {
    return [];
  }
}

/**
 * 获取即将上映电影
 */
export async function doubanComingSoon(start: number = 0, limit: number = 20): Promise<{
  subjects: DoubanComingMovie[];
  total: number;
}> {
  const url = `https://movie.douban.com/j/search_subjects?type=movie&tag=即将上映&page_limit=${limit}&page_start=${start}`;
  
  const response = await doubanFetch(url);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * 获取正在热映电影
 */
export async function doubanNowPlaying(start: number = 0, limit: number = 20): Promise<{
  subjects: DoubanSubject[];
}> {
  const url = `https://movie.douban.com/j/search_subjects?type=movie&tag=热门&page_limit=${limit}&page_start=${start}`;
  
  const response = await doubanFetch(url);
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * 获取北美票房榜
 */
export async function doubanUSBox(): Promise<DoubanBoxOffice[]> {
  const url = 'https://movie.douban.com/j/chart/us_box';
  
  try {
    const response = await doubanFetch(url, { timeout: 8000 });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    return data.subjects || [];
  } catch {
    return [];
  }
}

// ==================== 类型定义 ====================

export interface DoubanSubject {
  id: string;
  title: string;
  rate: string;
  cover: string;
  url: string;
  episode_info?: string;
}

export interface DoubanNewSearchSubject {
  id: string;
  title: string;
  cover: string;
  rate: string;
  url: string;
  casts?: string[];
  directors?: string[];
  cover_x?: number;
  cover_y?: number;
}

export interface DoubanSubjectDetail {
  subject?: {
    id: string;
    title: string;
    rate: string;
    url: string;
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

export interface DoubanCelebrity {
  id: string;
  name: string;
  name_en?: string;
  avatar?: string;
  gender?: string;
  birthday?: string;
  birthplace?: string;
  professions?: string[];
  works?: Array<{
    id: string;
    title: string;
    cover: string;
    rate: string;
    year: string;
  }>;
}

export interface DoubanEpisode {
  id: string;
  title: string;
  episode_number: number;
  air_date?: string;
  rate?: string;
  votes?: number;
}

export interface DoubanComment {
  id: string;
  content: string;
  rating?: {
    value: number;
    max: number;
  };
  author: {
    name: string;
    avatar?: string;
    uid?: string;
  };
  created_at: string;
  useful_count?: number;
  useless_count?: number;
}

export interface DoubanChartSubject {
  subject: {
    id: string;
    title: string;
    cover: string;
    rate: string;
    url: string;
    is_new?: boolean;
  };
  rank?: number;
  delta?: number;  // 排名变化
}

export interface DoubanPhoto {
  id: string;
  image: string;
  thumb: string;
  width?: number;
  height?: number;
  author?: {
    name: string;
    uid: string;
  };
}

export interface DoubanComingMovie extends DoubanSubject {
  release_date?: string;
  regions?: string[];
  wish_count?: number;
}

export interface DoubanBoxOffice {
  subject: {
    id: string;
    title: string;
    cover: string;
    rate: string;
    url: string;
  };
  rank: number;
  box: number;  // 票房数字
  new?: boolean;
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
