import { useState, useEffect, useCallback } from "react";
import type { DoubanMovie } from "@/types/douban";
import type { CategoryData, HeroData, HeroMovie } from "@/types/home";

interface UseHomeDataReturn {
  categories: CategoryData[];
  top250Movies: DoubanMovie[];
  heroMovies: DoubanMovie[];
  heroDataList: HeroData[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * 管理首页数据加载
 */
export function useHomeData(): UseHomeDataReturn {
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [top250Movies, setTop250Movies] = useState<DoubanMovie[]>([]);
  const [heroMovies, setHeroMovies] = useState<DoubanMovie[]>([]);
  const [heroDataList, setHeroDataList] = useState<HeroData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      // 并行加载 Hero、新 API 数据和 Top250
      const [heroRes, newApiRes, top250Res] = await Promise.all([
        fetch("/api/douban/hero"),
        fetch("/api/douban/new"),
        fetch("/api/douban/250"),
      ]);

      if (!heroRes.ok || !newApiRes.ok || !top250Res.ok) {
        throw new Error("数据加载失败");
      }

      const [heroApiData, newApiData, top250Data] = await Promise.all([
        heroRes.json(),
        newApiRes.json(),
        top250Res.json(),
      ]);

      // 处理 Hero Banner 数据（现在是数组）
      if (heroApiData.code === 200 && heroApiData.data && Array.isArray(heroApiData.data)) {
        const heroes = heroApiData.data;
        const heroMoviesList: HeroMovie[] = heroes.map((hero: {
          id: string;
          title: string;
          cover: string;
          url: string;
          rate: string;
          episode_info?: string;
          poster_horizontal: string;
          poster_vertical: string;
          description?: string;
          genres?: string[];
        }) => ({
          id: hero.id,
          title: hero.title,
          cover: hero.cover || "",
          url: hero.url || "",
          rate: hero.rate || "",
          episode_info: hero.episode_info || "",
          cover_x: 0,
          cover_y: 0,
          playable: false,
          is_new: false,
        }));

        const heroDataArray: HeroData[] = heroes.map((hero: {
          poster_horizontal: string;
          poster_vertical: string;
          description?: string;
          genres?: string[];
        }) => ({
          poster_horizontal: hero.poster_horizontal,
          poster_vertical: hero.poster_vertical,
          description: hero.description,
          genres: hero.genres,
        }));

        setHeroMovies(heroMoviesList);
        setHeroDataList(heroDataArray);
      }

      // 处理新 API 数据（9个分类）
      if (newApiData.code === 200 && newApiData.data) {
        setCategories(newApiData.data);
      }

      // 处理 Top250 数据
      if (top250Data.code === 200 && top250Data.data?.subjects) {
        setTop250Movies(top250Data.data.subjects);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "数据加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    categories,
    top250Movies,
    heroMovies,
    heroDataList,
    loading,
    error,
    refetch: fetchData,
  };
}
