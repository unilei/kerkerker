import useSWRInfinite from 'swr/infinite';
import { useMemo, useCallback } from 'react';
import type { DoubanMovie } from '@/types/douban';
import type { CatalogResponse, CatalogSubject } from '@/types/content-catalog';
import { useLocale } from '@/components/providers/locale-provider';

const ITEMS_PER_PAGE = 20;

// 转换数据格式 - Subject 转 DoubanMovie
function convertToDoubanMovie(item: CatalogSubject): DoubanMovie {
  return {
    id: item.id,
    title: item.title,
    cover: item.cover || '',
    url: item.url || '',
    rate: item.rate || '',
    episode_info: item.episode_info || '',
    cover_x: 0,
    cover_y: 0,
    playable: false,
    is_new: false,
  };
}

interface UseCategoryDataReturn {
  movies: DoubanMovie[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refetch: () => Promise<void>;
}

/**
 * 管理分类页数据加载
 * 使用 SWR Infinite 实现无限滚动缓存
 */
export function useCategoryData(categoryType: string): UseCategoryDataReturn {
  const { locale } = useLocale();
  const isTop250 = categoryType === 'top250';

  // 生成 SWR key
  const getKey = useCallback(
    (pageIndex: number, previousPageData: CatalogResponse | null) => {
      // Top250 只需要一页
      if (isTop250 && pageIndex > 0) return null;
      // 如果上一页没有更多数据，停止
      if (previousPageData && !isTop250 && !previousPageData.pagination?.hasMore) return null;
      // 返回 key
      return `category-${categoryType}-page-${pageIndex + 1}-locale-${locale}`;
    },
    [categoryType, isTop250, locale]
  );

  // 数据获取函数
  const fetcher = useCallback(
    async (key: string): Promise<CatalogResponse> => {
      const pageMatch = key.match(/page-(\d+)(?:-|$)/);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      const params = new URLSearchParams({
        category: isTop250 ? 'top250' : categoryType,
        page: String(page),
        limit: String(ITEMS_PER_PAGE),
      });
      const response = await fetch(`/api/content/catalog?${params.toString()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: CatalogResponse;
        message?: string;
        error_code?: string;
      } | null;
      if (!response.ok) {
        const configuredMessage = typeof payload?.message === "string" ? payload.message.trim() : "";
        const isEnglish = locale === "en-US";
        throw new Error(
          isEnglish
            ? configuredMessage || `Catalog request failed (HTTP ${response.status})`
            : configuredMessage || `目录请求失败（HTTP ${response.status}）`
        );
      }
      if (!payload?.data) {
        throw new Error(locale === "en-US" ? "Catalog response is missing data" : "目录响应缺少数据");
      }
      return payload.data;
    },
    [categoryType, isTop250, locale]
  );

  const {
    data,
    error,
    size,
    setSize,
    isLoading,
    isValidating,
    mutate,
  } = useSWRInfinite(getKey, fetcher, {
    revalidateFirstPage: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  // 合并所有页的数据
  const movies = useMemo(() => {
    if (!data) return [];
    const allSubjects: CatalogSubject[] = [];
    const seenIds = new Set<string>();
    
    for (const page of data) {
      if (page?.subjects) {
        for (const subject of page.subjects) {
          if (!seenIds.has(subject.id)) {
            seenIds.add(subject.id);
            allSubjects.push(subject);
          }
        }
      }
    }
    
    return allSubjects.map(convertToDoubanMovie);
  }, [data]);

  // 判断是否还有更多
  const hasMore = useMemo(() => {
    if (isTop250) return false;
    if (!data || data.length === 0) return true;
    const lastPage = data[data.length - 1];
    // Only CategoryResponse has pagination property
    if (lastPage && 'pagination' in lastPage && lastPage.pagination) {
      return lastPage.pagination.hasMore ?? false;
    }
    return false;
  }, [data, isTop250]);

  // 加载更多
  const loadMore = useCallback(() => {
    if (!isValidating && hasMore) {
      setSize(size + 1);
    }
  }, [setSize, size, isValidating, hasMore]);

  // 刷新数据
  const refetch = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    movies,
    loading: isLoading && !data,
    loadingMore: isValidating && data !== undefined && data.length > 0,
    error: error?.message || null,
    hasMore,
    loadMore,
    refetch,
  };
}
