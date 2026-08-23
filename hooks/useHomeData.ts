import useSWR from 'swr';
import { useCallback, useMemo } from 'react';
import type { DoubanMovie } from '@/types/douban';
import type { CategoryData, HeroData, HeroMovie } from '@/types/home';
import type { CatalogResponse } from '@/types/content-catalog';
import { useLocale } from '@/components/providers/locale-provider';

// SWR 缓存键
const SWR_KEY_HERO = '/api/content/catalog?view=featured';
const SWR_KEY_CATEGORIES = '/api/content/catalog?view=new-releases';

async function fetchCatalog(url: string): Promise<CatalogResponse> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`内容目录请求失败（HTTP ${response.status}）`);
  }
  const payload = (await response.json()) as { data?: CatalogResponse };
  if (!payload.data) throw new Error('内容目录响应缺少数据');
  return payload.data;
}

interface UseHomeDataReturn {
  categories: CategoryData[];
  heroMovies: DoubanMovie[];
  heroDataList: HeroData[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * 管理首页数据加载
 * 使用 SWR 实现缓存，页面返回时不会重复加载
 */
export function useHomeData(): UseHomeDataReturn {
  const { locale } = useLocale();
  // The fragment is intentionally client-only: it partitions SWR caches while
  // the locale preference itself travels to the server in the kk_locale cookie.
  const heroKey = `${SWR_KEY_HERO}#${locale}`;
  const categoriesKey = `${SWR_KEY_CATEGORIES}#${locale}`;
  // Hero Banner 数据
  const {
    data: heroData,
    error: heroError,
    isLoading: heroLoading,
    mutate: mutateHero,
  } = useSWR<CatalogResponse>(heroKey, fetchCatalog);

  // 分类数据
  const {
    data: categoryData,
    error: categoryError,
    mutate: mutateCategories,
  } = useSWR<CatalogResponse>(categoriesKey, fetchCatalog);

  // 转换 Hero 数据格式
  const { heroMovies, heroDataList } = useMemo(() => {
    if (!heroData || !Array.isArray(heroData.items)) {
      return { heroMovies: [], heroDataList: [] };
    }

    const heroMoviesList: HeroMovie[] = heroData.items.map((item) => ({
      id: item.id,
      title: item.title,
      cover: item.posterUrl || '',
      url: item.canonicalUrl || '',
      rate: item.rating || '',
      episode_info: item.episodeInfo || '',
      cover_x: 0,
      cover_y: 0,
      playable: false,
      is_new: false,
    }));

    const heroDataArray: HeroData[] = heroData.items.map((item) => ({
      poster_horizontal: item.backdropUrl || item.posterUrl,
      poster_vertical: item.posterUrl,
      description: item.description,
      genres: item.genres,
    }));

    return { heroMovies: heroMoviesList, heroDataList: heroDataArray };
  }, [heroData]);

  // 转换分类数据格式
  const categories = useMemo(() => {
    if (!categoryData || !Array.isArray(categoryData.sections)) {
      return [];
    }

    return categoryData.sections.map((section) => ({
      name: section.title,
      data: section.items.map((item) => ({
        id: item.id,
        title: item.title,
        rate: item.rating,
        cover: item.posterUrl,
        url: item.canonicalUrl,
        episode_info: item.episodeInfo,
      })),
    }));
  }, [categoryData]);

  // 刷新所有数据
  const refetch = useCallback(async () => {
    await Promise.all([mutateHero(), mutateCategories()]);
  }, [mutateHero, mutateCategories]);

  // 合并错误信息
  const error = heroError?.message || categoryError?.message || null;

  // 仅在 Hero 加载中时显示 loading
  // 分类数据可以后台加载
  const loading = heroLoading && !heroData;

  return {
    categories,
    heroMovies,
    heroDataList,
    loading,
    error,
    refetch,
  };
}
