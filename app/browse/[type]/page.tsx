"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import {
  Film,
  Tv,
  Clapperboard,
  Globe,
  RefreshCw,
  Flame,
  Star,
  Zap,
  Smile,
  Rocket,
  Ghost,
  Heart,
  Palette,
  Drama,
} from "lucide-react";
import DoubanCard from "@/components/DoubanCard";
import { DoubanMovie } from "@/types/douban";
import { useMovieMatch } from "@/hooks/useMovieMatch";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { Toast } from "@/components/Toast";
import { useLocale } from "@/components/providers/locale-provider";
import { LanguageSwitcher } from "@/components/home/LanguageSwitcher";
import type {
  CatalogFilters,
  CatalogItem,
  CatalogResponse,
  CatalogView,
} from "@/types/content-catalog";

// ============ 页面配置 ============
interface PageConfig {
  title: string;
  emoji: string;
  catalogView: Extract<CatalogView, "sections" | "latest">;
  catalogKey?: "movies" | "series";
  gradient: string;
  bgColor1: string;
  bgColor2: string;
  hasFilters: boolean;
  hasCategories: boolean;
}

const PAGE_CONFIG: Record<string, PageConfig> = {
  movies: {
    title: "电影",
    emoji: "🎬",
    catalogView: "sections",
    catalogKey: "movies",
    gradient: "from-red-500/5 via-transparent to-purple-500/5",
    bgColor1: "bg-red-500/10",
    bgColor2: "bg-purple-500/10",
    hasFilters: false,
    hasCategories: true,
  },
  tv: {
    title: "电视剧",
    emoji: "📺",
    catalogView: "sections",
    catalogKey: "series",
    gradient: "from-blue-500/5 via-transparent to-purple-500/5",
    bgColor1: "bg-blue-500/10",
    bgColor2: "bg-purple-500/10",
    hasFilters: false,
    hasCategories: true,
  },
  latest: {
    title: "最新",
    emoji: "🆕",
    catalogView: "latest",
    gradient: "from-green-500/5 via-transparent to-blue-500/5",
    bgColor1: "bg-green-500/10",
    bgColor2: "bg-blue-500/10",
    hasFilters: true,
    hasCategories: false,
  },
};

// ============ 筛选选项配置 ============
const GENRE_OPTIONS = [
  "全部",
  "剧情",
  "科幻",
  "动作",
  "喜剧",
  "爱情",
  "冒险",
  "儿童",
  "歌舞",
  "音乐",
  "奇幻",
  "动画",
  "恐怖",
  "惊悚",
  "战争",
  "传记",
  "纪录片",
  "犯罪",
  "悬疑",
  "灾难",
  "古装",
  "武侠",
  "家庭",
  "短片",
  "校园",
  "文艺",
  "运动",
  "青春",
  "励志",
  "美食",
  "治愈",
  "历史",
  "真人秀",
  "脱口秀",
];

const YEAR_OPTIONS = [
  "全部",
  "2026",
  "2025",
  "2024",
  "2023",
  "2022",
  "2021",
  "2020",
  "2019",
  "2018",
  "2017",
  "2016",
  "2015",
  "20年代",
  "10年代",
  "00年代",
  "90年代",
  "80年代",
  "70年代",
  "60年代",
  "更早",
];

const REGION_OPTIONS = [
  "全部",
  "大陆",
  "香港",
  "台湾",
  "亚洲",
  "海外",
  "欧美",
  "美国",
  "日本",
  "韩国",
  "英国",
  "法国",
  "德国",
  "印度",
  "泰国",
  "瑞典",
  "巴西",
  "加拿大",
  "俄罗斯",
  "意大利",
  "西班牙",
  "澳大利亚",
];

const SORT_OPTIONS = ["热门", "时间", "评分"];

// ============ 分类图标映射 ============
const CATEGORY_ICONS: Record<string, React.JSX.Element> = {
  热门电影: <Flame className="w-5 h-5 text-orange-500" />,
  豆瓣高分: <Star className="w-5 h-5 text-yellow-500 fill-current" />,
  动作片: <Zap className="w-5 h-5 text-red-500" />,
  喜剧片: <Smile className="w-5 h-5 text-yellow-400" />,
  科幻片: <Rocket className="w-5 h-5 text-blue-500" />,
  惊悚片: <Ghost className="w-5 h-5 text-purple-500" />,
  爱情片: <Heart className="w-5 h-5 text-pink-500 fill-current" />,
  动画电影: <Palette className="w-5 h-5 text-green-500" />,
  热门剧集: <Flame className="w-5 h-5 text-orange-500" />,
  国产剧: <Drama className="w-5 h-5 text-red-500" />,
  美剧: <Globe className="w-5 h-5 text-blue-500" />,
  日剧: <Tv className="w-5 h-5 text-pink-500" />,
  韩剧: <Tv className="w-5 h-5 text-purple-500" />,
  英剧: <Globe className="w-5 h-5 text-indigo-500" />,
  综艺节目: <Clapperboard className="w-5 h-5 text-yellow-500" />,
  日本动画: <Palette className="w-5 h-5 text-green-500" />,
};

// ============ 类型定义 ============
interface CategoryData {
  name: string;
  data: CatalogItem[];
}

interface Filters {
  genre: string;
  year: string;
  region: string;
  sort: string;
}

const SORT_INTENT: Record<string, NonNullable<CatalogFilters["sort"]>> = {
  热门: "recommended",
  时间: "release-date",
  评分: "rating",
};
const ITEMS_PER_PAGE = 30;

function catalogUrl(
  config: PageConfig,
  filters: Filters,
  page: number,
  limit: number
): string {
  const params = new URLSearchParams({
    view: config.catalogView,
    page: String(page),
    limit: String(limit),
  });
  if (config.catalogKey) params.set("key", config.catalogKey);
  if (config.catalogView === "latest") {
    if (filters.genre) params.set("genre", filters.genre);
    if (filters.year) params.set("year", filters.year);
    if (filters.region) params.set("region", filters.region);
    if (filters.sort) params.set("sort", SORT_INTENT[filters.sort]);
  }
  return `/api/content/catalog?${params.toString()}`;
}

async function fetchCatalog(url: string): Promise<CatalogResponse> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json()) as {
    data?: CatalogResponse;
    message?: string;
  };
  if (!response.ok || !payload.data) {
    throw new Error(payload.message || `内容目录请求失败（HTTP ${response.status}）`);
  }
  return payload.data;
}

// ============ 筛选行组件 ============
function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-800/50 last:border-b-0">
      <span className="text-gray-400 text-sm whitespace-nowrap min-w-12 pt-1">
        {label}：
      </span>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((option) => {
          const isActive = option === "全部" ? !value : value === option;
          return (
            <button
              key={option}
              onClick={() => onChange(option === "全部" ? "" : option)}
              className={`text-sm transition-colors ${
                isActive
                  ? "text-blue-500 font-medium"
                  : "text-gray-300 hover:text-white"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============ 主组件 ============
export default function BrowsePage() {
  const router = useRouter();
  const params = useParams();
  const pageType = (params.type as string) || "movies";
  const { locale } = useLocale();

  const config = PAGE_CONFIG[pageType] || PAGE_CONFIG.movies;

  // 使用影片点击 hook（与首页一致，点击后跳转详情页）
  const { handleMovieClick, toast, setToast } = useMovieMatch();

  // 筛选与客户端分页状态
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(() => ({
    genre: "",
    year: "",
    region: "",
    sort: "",
  }));
  const hasActiveFilters = Boolean(
    filters.genre || filters.year || filters.region || filters.sort
  );
  const useServerPagination = config.catalogView === "latest" && hasActiveFilters;

  const baseCatalogKey = useServerPagination
    ? null
    : `${catalogUrl(config, filters, 1, ITEMS_PER_PAGE)}#${locale}`;
  const {
    data: baseData,
    error: baseError,
    isLoading: baseLoading,
    mutate: mutateBase,
  } = useSWR<CatalogResponse>(baseCatalogKey, fetchCatalog, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const getPageKey = useCallback(
    (pageIndex: number, previousPageData: CatalogResponse | null) => {
      if (!useServerPagination) return null;
      if (previousPageData && !previousPageData.pagination.hasMore) return null;
      return `${catalogUrl(config, filters, pageIndex + 1, ITEMS_PER_PAGE)}#${locale}`;
    },
    [config, filters, locale, useServerPagination]
  );
  const {
    data: pagedData,
    error: pagedError,
    size,
    setSize,
    isLoading: pagedLoading,
    isValidating: pagedValidating,
    mutate: mutatePaged,
  } = useSWRInfinite<CatalogResponse>(getPageKey, fetchCatalog, {
    revalidateFirstPage: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const categories = useMemo<CategoryData[]>(
    () =>
      (baseData?.sections || []).map((section) => ({
        name: section.title,
        data: section.items,
      })),
    [baseData]
  );

  const allMovies = useMemo(() => {
    const pages = useServerPagination ? pagedData || [] : baseData ? [baseData] : [];
    const items: CatalogItem[] = [];
    const seenIds = new Set<string>();
    for (const catalogPage of pages) {
      for (const item of catalogPage.items) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        items.push(item);
      }
    }
    return items;
  }, [baseData, pagedData, useServerPagination]);

  // 未筛选时由浏览器分页；筛选结果遵循插件返回的服务端游标。
  const movies = useServerPagination
    ? allMovies
    : allMovies.slice(0, page * ITEMS_PER_PAGE);
  const loading = useServerPagination
    ? pagedLoading && !pagedData
    : baseLoading && !baseData;
  const loadingMore = useServerPagination && pagedValidating && Boolean(pagedData);
  const requestError = useServerPagination ? pagedError : baseError;
  const error = requestError instanceof Error ? requestError.message : null;
  const hasMore = useMemo(() => {
    if (!useServerPagination) {
      return allMovies.length > page * ITEMS_PER_PAGE;
    }
    if (!pagedData || pagedData.length === 0) return true;
    const lastPage = pagedData[pagedData.length - 1];
    if (!lastPage.pagination.hasMore) return false;
    if (pagedData.length === 1) return true;

    // Some legacy providers may return the cached first page for a later cursor.
    // Stop rather than offering an endless "load more" loop with duplicate cards.
    const previousIds = new Set(
      pagedData.slice(0, -1).flatMap((catalogPage) =>
        catalogPage.items.map((item) => item.id)
      )
    );
    return lastPage.items.some((item) => !previousIds.has(item.id));
  }, [allMovies.length, page, pagedData, useServerPagination]);

  // 滚动位置恢复（等待加载完成后恢复）
  useScrollRestoration(`browse-${pageType}`, { delay: 100, enabled: !loading });

  // 获取分类图标
  const getCategoryIcon = (name: string): React.JSX.Element => {
    return CATEGORY_ICONS[name] || <Flame className="w-5 h-5 text-gray-400" />;
  };

  // 转换数据格式
  const convertToDoubanMovie = (item: CatalogItem): DoubanMovie => ({
    id: item.id,
    title: item.title,
    cover: item.posterUrl || "",
    url: item.canonicalUrl || "",
    rate: item.rating || "",
    episode_info: item.episodeInfo || "",
    cover_x: 0,
    cover_y: 0,
    playable: false,
    is_new: false,
  });

  // 加载更多
  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      if (useServerPagination) {
        void setSize(size + 1);
      } else {
        setPage((currentPage) => currentPage + 1);
      }
    }
  }, [hasMore, loadingMore, setSize, size, useServerPagination]);

  const refetch = useCallback(async () => {
    if (useServerPagination) {
      await mutatePaged();
    } else {
      await mutateBase();
    }
  }, [mutateBase, mutatePaged, useServerPagination]);

  const goBack = () => {
    router.push("/");
  };

  // 更新筛选器
  const updateFilter = (key: keyof Filters, value: string) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setPage(1);
    setFilters({ genre: "", year: "", region: "", sort: "" });
  };

  // 获取统计文字
  const getStatsText = () => {
    if (loading) return "正在加载精彩内容...";
    if (config.hasCategories) {
      return `探索 ${categories.length} 个精选分类`;
    }
    return `发现 ${movies.length} 部影视作品`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-gray-950 to-black text-white">
      {/* 顶部导航栏 */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-black/90 backdrop-blur-md border-b border-gray-800/50">
        <div className="px-4 md:px-12 py-5">
          <div className="flex items-center justify-between">
            <button
              onClick={goBack}
              className="flex items-center gap-2 text-white/80 hover:text-white transition-all group"
            >
              <div className="p-1.5 rounded-full bg-white/5 group-hover:bg-white/10 transition-colors">
                <svg
                  className="w-5 h-5 group-hover:-translate-x-0.5 transition-transform"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </div>
              <span className="text-sm md:text-base font-medium">返回</span>
            </button>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight bg-gradient-to-r from-red-600 to-red-500 bg-clip-text text-transparent">
              爱盼
            </h1>
            <LanguageSwitcher compact />
          </div>
        </div>
      </nav>

      {/* Hero 区域 */}
      <div className="relative pt-24 pb-4 px-4 md:px-12 overflow-hidden">
        {/* 装饰性背景 */}
        <div
          className={`absolute inset-0 bg-gradient-to-r ${config.gradient}`}
        />
        <div
          className={`absolute top-0 right-0 w-96 h-96 ${config.bgColor1} rounded-full blur-3xl`}
        />
        <div
          className={`absolute bottom-0 left-0 w-96 h-96 ${config.bgColor2} rounded-full blur-3xl`}
        />

        <div className="relative">
          <div className="flex items-center gap-4 mb-4">
            <div className="text-4xl md:text-5xl">{config.emoji}</div>
            <div>
              <h1 className="text-2xl lg:text-4xl font-bold text-white mb-1 tracking-tight">
                {config.title}
              </h1>
              <p className="text-sm md:text-base text-gray-400">
                {getStatsText()}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 筛选器（仅 latest） */}
      {config.hasFilters && (
        <div className="px-4 md:px-12 py-4 bg-gray-900/50 border-y border-gray-800/50">
          <FilterRow
            label="类型"
            options={GENRE_OPTIONS}
            value={filters.genre}
            onChange={(v) => updateFilter("genre", v)}
          />
          <FilterRow
            label="年代"
            options={YEAR_OPTIONS}
            value={filters.year}
            onChange={(v) => updateFilter("year", v)}
          />
          <FilterRow
            label="地区"
            options={REGION_OPTIONS}
            value={filters.region}
            onChange={(v) => updateFilter("region", v)}
          />
          <FilterRow
            label="排序"
            options={SORT_OPTIONS}
            value={filters.sort}
            onChange={(v) => updateFilter("sort", v)}
          />
        </div>
      )}

      {/* 内容区域 */}
      <div className="px-4 md:px-12 pb-16 pt-6">
        {loading ? (
          <div className="flex items-center justify-center py-32">
            <div className="text-center">
              <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-700 border-t-red-600 mx-auto mb-4" />
              <p className="text-gray-400 text-lg">正在加载精彩内容...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-32">
            <div className="text-center">
              <p className="text-red-500 mb-4">{error}</p>
              <button
                onClick={() => void refetch()}
                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors shadow-lg shadow-red-600/20 flex items-center gap-2 mx-auto"
              >
                <RefreshCw className="w-4 h-4" />
                重新加载
              </button>
            </div>
          </div>
        ) : config.hasCategories ? (
          // 分类视图 (movies/tv)
          <div className="space-y-12">
            {categories.map((category, index) => {
              const categoryMovies = category.data.map(convertToDoubanMovie);

              return (
                <div key={index} className="group">
                  <div className="flex items-center justify-between mb-4 mt-2">
                    <h2 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
                      <span>{getCategoryIcon(category.name)}</span>
                      <span className="bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
                        {category.name}
                      </span>
                    </h2>
                    <div className="text-sm text-gray-500">
                      {categoryMovies.length} 部
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-8 gap-3 md:gap-4 lg:gap-5">
                    {categoryMovies.map((movie) => (
                      <div
                        key={movie.id}
                        className="transform transition-all duration-300 hover:scale-105"
                      >
                        <DoubanCard movie={movie} onSelect={handleMovieClick} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : movies.length === 0 ? (
          // 空状态 (latest)
          <div className="flex items-center justify-center py-32">
            <div className="text-center">
              <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4">
                <Film className="w-10 h-10 text-gray-600" />
              </div>
              <h3 className="text-xl font-bold text-white mb-2">暂无内容</h3>
              <p className="text-gray-400 mb-6">
                没有找到符合筛选条件的影视作品
              </p>
              <button
                onClick={resetFilters}
                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                重置筛选条件
              </button>
            </div>
          </div>
        ) : (
          // 网格视图 (latest)
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-8 gap-3 md:gap-4 lg:gap-5">
              {movies.map((item, index) => {
                const movie = convertToDoubanMovie(item);
                return (
                  <div
                    key={`${movie.id}-${index}`}
                    className="transform transition-all duration-300 hover:scale-105"
                  >
                    <DoubanCard movie={movie} onSelect={handleMovieClick} />
                  </div>
                );
              })}
            </div>

            {/* 加载更多按钮 */}
            {config.hasFilters && (
              <div className="flex justify-center mt-8">
                {loadingMore ? (
                  <div className="flex items-center gap-2 text-gray-400">
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-600 border-t-red-500" />
                    <span>加载中...</span>
                  </div>
                ) : hasMore ? (
                  <button
                    onClick={loadMore}
                    className="px-8 py-3 bg-white/5 hover:bg-white/10 text-white rounded-lg font-medium transition-colors border border-white/10 hover:border-white/20"
                  >
                    加载更多
                  </button>
                ) : movies.length > 0 ? (
                  <p className="text-gray-500 text-sm">已加载全部内容</p>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {/* Toast 提示 */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
