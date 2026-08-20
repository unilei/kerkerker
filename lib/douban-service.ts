/**
 * Douban API Service Client
 * 
 * Douban 内容插件内部使用的 kerkerker-douban-service 客户端。
 * 页面、Hook 和后台任务必须通过宿主插件边界，不能直接导入本模块。
 * 服务地址在宿主运行配置中由 NEXT_PUBLIC_DOUBAN_API_URL 提供。
 */

const DOUBAN_API_URL = process.env.NEXT_PUBLIC_DOUBAN_API_URL || 'https://iamyourfather.link0.me'

export interface ServiceRequestOptions {
  signal?: AbortSignal;
  /** Optional provider endpoint override used by the plugin runtime. */
  baseUrl?: string;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(15000);
  if (!signal) return timeoutSignal;
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : signal;
}

/**
 * 通用请求函数
 */
async function fetchFromService<T>(
  endpoint: string,
  options?: RequestInit & ServiceRequestOptions
): Promise<T> {
  const result = await fetchServiceResult<T>(endpoint, options);
  return result.data;
}

interface ServiceResult<T> {
  data: T;
  envelope?: Record<string, unknown>;
}

/** Preserve optional response metadata for plugin adapters that expose paging. */
async function fetchServiceResult<T>(
  endpoint: string,
  options?: RequestInit & ServiceRequestOptions
): Promise<ServiceResult<T>> {
  const { baseUrl, ...requestOptions } = options || {};
  const url = `${baseUrl || DOUBAN_API_URL}${endpoint}`;
  
  try {
    const response = await fetch(url, {
      ...requestOptions,
      headers: {
        'Content-Type': 'application/json',
        ...requestOptions.headers,
      },
      signal: requestSignal(requestOptions.signal),
    });
    
    if (!response.ok) {
      throw new Error(`Douban service request failed: HTTP ${response.status}`);
    }

    const data: unknown = await response.json();
    
    // Go 服务的响应格式有两种：
    // 1. 包装格式: { code: 200, data: {...} }
    // 2. 直接格式: { id: ..., title: ... }
    if (
      data !== null &&
      typeof data === 'object' &&
      'code' in data &&
      'data' in data &&
      data.data !== undefined
    ) {
      return {
        data: data.data as T,
        envelope: data as Record<string, unknown>,
      };
    }
    return { data: data as T };
  } catch (error) {
    console.error(`Douban API error [${endpoint}]:`, error);
    throw error;
  }
}

// ==================== Hero Banner ====================

export interface HeroMovie {
  id: string;
  title: string;
  rate: string;
  cover: string;
  poster_horizontal: string;
  poster_vertical: string;
  url: string;
  episode_info?: string;
  genres?: string[];
  description?: string;
}

export async function getHeroMovies(
  requestOptions?: ServiceRequestOptions
): Promise<HeroMovie[]> {
  return fetchFromService<HeroMovie[]>('/api/v1/hero', requestOptions);
}

export async function clearHeroCache(): Promise<void> {
  await fetchFromService('/api/v1/hero', { method: 'DELETE' });
}

// ==================== Category ====================

export interface Subject {
  id: string;
  title: string;
  rate: string;
  cover: string;
  url: string;
  episode_info?: string;
}

export interface CategoryPagination {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface CategoryResponse {
  subjects: Subject[];
  pagination: CategoryPagination;
}

export async function getCategoryData(
  category: string,
  page: number = 1,
  limit: number = 20,
  requestOptions?: ServiceRequestOptions
): Promise<CategoryResponse> {
  return fetchFromService<CategoryResponse>(
    `/api/v1/category?category=${encodeURIComponent(category)}&page=${page}&limit=${limit}`,
    requestOptions
  );
}

export interface Top250Response {
  subjects: Subject[];
}

export async function getTop250(requestOptions?: ServiceRequestOptions): Promise<Top250Response> {
  return fetchFromService<Top250Response>('/api/v1/250', requestOptions);
}

// ==================== Detail ====================

export interface SubjectDetail {
  id: string;
  internal_id?: number;
  title: string;
  rate: string;
  url: string;
  cover: string;
  types: string[];
  release_year: string;
  directors: string[];
  actors: string[];
  duration: string;
  region: string;
  episodes_count: string;
  description?: string;
  short_comment?: {
    content: string;
    author: { name: string };
  };
  photos?: Array<{ id: string; image: string; thumb: string }>;
  comments?: Array<{ id: string; content: string; author: { name: string } }>;
  recommendations?: Subject[];
}

export async function getSubjectDetail(
  id: string,
  requestOptions?: ServiceRequestOptions
): Promise<SubjectDetail | null> {
  try {
    return await fetchFromService<SubjectDetail>(
      `/api/v1/detail/${encodeURIComponent(id)}`,
      requestOptions
    );
  } catch {
    return null;
  }
}

export async function getMovieByInternalID(internalId: number | string): Promise<SubjectDetail | null> {
  try {
    return await fetchFromService<SubjectDetail>(`/api/v1/movies/${internalId}`);
  } catch {
    return null;
  }
}

export async function clearDetailCache(id: string): Promise<void> {
  await fetchFromService(`/api/v1/detail/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ==================== Latest ====================

export interface CategoryData {
  name: string;
  data: Subject[];
}

export async function getLatestContent(): Promise<CategoryData[]> {
  return fetchFromService<CategoryData[]>('/api/v1/latest');
}

export async function clearLatestCache(): Promise<void> {
  await fetchFromService('/api/v1/latest', { method: 'DELETE' });
}

// ==================== Movies ====================

export async function getMoviesCategories(
  requestOptions?: ServiceRequestOptions
): Promise<CategoryData[]> {
  return fetchFromService<CategoryData[]>('/api/v1/movies', requestOptions);
}

export async function clearMoviesCache(): Promise<void> {
  await fetchFromService('/api/v1/movies', { method: 'DELETE' });
}

// ==================== TV ====================

export async function getTVCategories(
  requestOptions?: ServiceRequestOptions
): Promise<CategoryData[]> {
  return fetchFromService<CategoryData[]>('/api/v1/tv', requestOptions);
}

export async function clearTVCache(): Promise<void> {
  await fetchFromService('/api/v1/tv', { method: 'DELETE' });
}

// ==================== New ====================

export interface NewFilters {
  type?: string;
  year?: string;
  region?: string;
  genre?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface NewContentResponse {
  data: CategoryData[];
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
}

function newContentPagination(value: unknown): NewContentResponse['pagination'] {
  if (!value || typeof value !== 'object') return undefined;
  const pagination = value as Record<string, unknown>;
  if (
    typeof pagination.page !== 'number' ||
    typeof pagination.pageSize !== 'number' ||
    typeof pagination.total !== 'number' ||
    typeof pagination.hasMore !== 'boolean'
  ) {
    return undefined;
  }
  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: pagination.total,
    hasMore: pagination.hasMore,
  };
}

function newContentEndpoint(filters: NewFilters): string {
  const params = new URLSearchParams();
  if (filters.type) params.append('type', filters.type);
  if (filters.year) params.append('year', filters.year);
  if (filters.region) params.append('region', filters.region);
  if (filters.genre) params.append('genre', filters.genre);
  if (filters.sort) params.append('sort', filters.sort);
  if (filters.page) params.append('page', String(filters.page));
  if (filters.pageSize) params.append('pageSize', String(filters.pageSize));

  const queryString = params.toString();
  return queryString ? `/api/v1/new?${queryString}` : '/api/v1/new';
}

export async function getNewContent(
  filters: NewFilters = {},
  requestOptions?: ServiceRequestOptions
): Promise<CategoryData[]> {
  const response = await getNewContentPage(filters, requestOptions);
  return response.data;
}

export async function getNewContentPage(
  filters: NewFilters = {},
  requestOptions?: ServiceRequestOptions
): Promise<NewContentResponse> {
  const result = await fetchServiceResult<CategoryData[]>(
    newContentEndpoint(filters),
    requestOptions
  );
  return {
    data: result.data,
    pagination: newContentPagination(result.envelope?.pagination),
  };
}

export async function clearNewCache(): Promise<void> {
  await fetchFromService('/api/v1/new', { method: 'DELETE' });
}

// ==================== Search ====================

export interface SuggestItem {
  id: string;
  title: string;
  sub_title?: string;
  img: string;
  url: string;
  type: string;
  year?: string;
  episode?: string;
}

export interface SearchResult {
  suggest: SuggestItem[];
  advanced: Subject[] | null;
}

export async function searchDouban(
  query: string,
  type?: 'movie' | 'tv',
  options: { sort?: string; genres?: string; yearRange?: string; start?: number; limit?: number } = {},
  requestOptions?: ServiceRequestOptions
): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query });
  if (type) params.append('type', type);
  if (options.sort) params.append('sort', options.sort);
  if (options.genres) params.append('genres', options.genres);
  if (options.yearRange) params.append('year_range', options.yearRange);
  if (options.start) params.append('start', String(options.start));
  if (options.limit) params.append('limit', String(options.limit));
  
  return fetchFromService<SearchResult>(`/api/v1/search?${params.toString()}`, requestOptions);
}

export async function getSearchTags(type: 'movie' | 'tv'): Promise<string[]> {
  return fetchFromService<string[]>('/api/v1/search', {
    method: 'POST',
    body: JSON.stringify({ type }),
  });
}

// ==================== Service Status ====================

export interface ServiceStatus {
  status: string;
  proxy_enabled: boolean;
  proxy_count: number;
  tmdb_enabled: boolean;
}

export async function getServiceStatus(): Promise<ServiceStatus> {
  return fetchFromService<ServiceStatus>('/api/v1/status');
}

// ==================== Health Check ====================

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${DOUBAN_API_URL}/health`);
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * 获取 API 服务地址（供调试用）
 */
export function getDebugApiUrl(): string {
  return DOUBAN_API_URL;
}

// ==================== Calendar ====================

export interface CalendarEntry {
  show_id: number;
  show_name: string;
  show_name_cn?: string;
  season_number: number;
  episode_number: number;
  episode_name: string;
  air_date: string;
  poster: string;
  backdrop?: string;
  overview?: string;
  vote_average: number;
  douban_id?: string;
  douban_rating?: string;
}

export interface CalendarDay {
  date: string;
  entries: CalendarEntry[];
}

export interface CalendarResponse {
  start_date: string;
  end_date: string;
  days: CalendarDay[];
  total: number;
}

export interface CalendarFilters {
  start_date?: string;
  end_date?: string;
  region?: string;
}

export interface AiringFilters {
  page?: number;
  region?: string;
}

/**
 * 获取日历数据
 * @param filters 筛选参数
 */
export async function getCalendar(
  filters: CalendarFilters = {},
  requestOptions?: ServiceRequestOptions
): Promise<CalendarResponse> {
  const params = new URLSearchParams();
  if (filters.start_date) params.append('start_date', filters.start_date);
  if (filters.end_date) params.append('end_date', filters.end_date);
  if (filters.region) params.append('region', filters.region);
  
  const queryString = params.toString();
  const endpoint = queryString ? `/api/v1/calendar?${queryString}` : '/api/v1/calendar';
  
  return fetchFromService<CalendarResponse>(endpoint, requestOptions);
}

/**
 * 获取今日热播剧集
 * @param filters 筛选参数
 */
export async function getAiringToday(filters: AiringFilters = {}): Promise<CalendarEntry[]> {
  const params = new URLSearchParams();
  if (filters.page) params.append('page', String(filters.page));
  if (filters.region) params.append('region', filters.region);
  
  const queryString = params.toString();
  const endpoint = queryString ? `/api/v1/calendar/airing?${queryString}` : '/api/v1/calendar/airing';
  
  return fetchFromService<CalendarEntry[]>(endpoint);
}

/**
 * 清除日历缓存
 */
export async function clearCalendarCache(): Promise<void> {
  await fetchFromService('/api/v1/calendar', { method: 'DELETE' });
}
