import { useState, useEffect, useCallback, startTransition } from "react";
import type { DoubanMovie } from "@/types/douban";
import type { CategoryData, HeroData, HeroMovie } from "@/types/home";
import { getHeroMovies, getNewContent } from "@/lib/douban-service";

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
 * 采用串行加载策略，优先加载用户最先看到的内容
 * 直接调用 Go 微服务，无代理层
 */
export function useHomeData(): UseHomeDataReturn {
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [heroMovies, setHeroMovies] = useState<DoubanMovie[]>([]);
  const [heroDataList, setHeroDataList] = useState<HeroData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      // 1️⃣ 优先加载 Hero Banner（用户第一眼看到）
      const heroes = await getHeroMovies();

      if (heroes && Array.isArray(heroes)) {
        const heroMoviesList: HeroMovie[] = heroes.map((hero) => ({
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

        const heroDataArray: HeroData[] = heroes.map((hero) => ({
          poster_horizontal: hero.poster_horizontal,
          poster_vertical: hero.poster_vertical,
          description: hero.description,
          genres: hero.genres,
        }));

        setHeroMovies(heroMoviesList);
        setHeroDataList(heroDataArray);
        
        // Hero 加载完成后，立即结束 loading 状态，让用户可以交互
        setLoading(false);
      }

      // 2️⃣ 加载分类数据（用户滚动后看到）
      const newData = await getNewContent();
      if (newData && Array.isArray(newData)) {
        // 转换数据格式以匹配 CategoryData 类型
        const convertedCategories: CategoryData[] = newData.map(cat => ({
          name: cat.name,
          data: cat.data.map(item => ({
            id: item.id,
            title: item.title,
            rate: item.rate,
            cover: item.cover,
            url: item.url,
            episode_info: item.episode_info,
          }))
        }));
        // 使用 startTransition 让 UI 更新不阻塞交互
        startTransition(() => {
          setCategories(convertedCategories);
        });
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : "数据加载失败，请稍后重试");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    categories,
    heroMovies,
    heroDataList,
    loading,
    error,
    refetch: fetchData,
  };
}
