"use client";

import { Loader2 } from "lucide-react";
import { useRouter, useParams } from "next/navigation";
import {
  Film,
  Tv,
  Star,
  Flame,
  Trophy,
  Globe,
  Sparkles,
  Drama,
  Clapperboard,
  BookOpen,
} from "lucide-react";
import DoubanCard from "@/components/DoubanCard";
import { useMovieMatch } from "@/hooks/useMovieMatch";
import { useCategoryData } from "@/hooks/useCategoryData";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { Toast } from "@/components/Toast";

// URL 路径到分类配置的映射
const CATEGORY_CONFIG: Record<
  string,
  {
    name: string;
    emoji: string;
    icon: React.ReactNode;
    gradient: string;
    bgColor1: string;
    bgColor2: string;
  }
> = {
  in_theaters: {
    name: "豆瓣热映",
    emoji: "🔥",
    icon: <Flame className="w-5 h-5 text-orange-500" />,
    gradient: "from-orange-500/5 via-transparent to-red-500/5",
    bgColor1: "bg-orange-500/10",
    bgColor2: "bg-red-500/10",
  },
  top250: {
    name: "豆瓣 Top 250",
    emoji: "🏆",
    icon: <Trophy className="w-5 h-5 text-yellow-500" />,
    gradient: "from-yellow-500/5 via-transparent to-amber-500/5",
    bgColor1: "bg-yellow-500/10",
    bgColor2: "bg-amber-500/10",
  },
  hot_movies: {
    name: "热门电影",
    emoji: "🎬",
    icon: <Film className="w-5 h-5 text-red-500" />,
    gradient: "from-red-500/5 via-transparent to-pink-500/5",
    bgColor1: "bg-red-500/10",
    bgColor2: "bg-pink-500/10",
  },
  hot_tv: {
    name: "热门电视剧",
    emoji: "📺",
    icon: <Tv className="w-5 h-5 text-blue-500" />,
    gradient: "from-blue-500/5 via-transparent to-purple-500/5",
    bgColor1: "bg-blue-500/10",
    bgColor2: "bg-purple-500/10",
  },
  us_tv: {
    name: "美剧",
    emoji: "🇺🇸",
    icon: <Globe className="w-5 h-5 text-blue-400" />,
    gradient: "from-blue-500/5 via-transparent to-indigo-500/5",
    bgColor1: "bg-blue-500/10",
    bgColor2: "bg-indigo-500/10",
  },
  jp_tv: {
    name: "日剧",
    emoji: "🇯🇵",
    icon: <Sparkles className="w-5 h-5 text-pink-400" />,
    gradient: "from-pink-500/5 via-transparent to-rose-500/5",
    bgColor1: "bg-pink-500/10",
    bgColor2: "bg-rose-500/10",
  },
  kr_tv: {
    name: "韩剧",
    emoji: "🇰🇷",
    icon: <Star className="w-5 h-5 text-purple-400" />,
    gradient: "from-purple-500/5 via-transparent to-violet-500/5",
    bgColor1: "bg-purple-500/10",
    bgColor2: "bg-violet-500/10",
  },
  anime: {
    name: "日本动画",
    emoji: "🎨",
    icon: <Sparkles className="w-5 h-5 text-green-400" />,
    gradient: "from-green-500/5 via-transparent to-teal-500/5",
    bgColor1: "bg-green-500/10",
    bgColor2: "bg-teal-500/10",
  },
  chinese_tv: {
    name: "国产剧",
    emoji: "🇨🇳",
    icon: <Drama className="w-5 h-5 text-red-500" />,
    gradient: "from-red-500/5 via-transparent to-orange-500/5",
    bgColor1: "bg-red-500/10",
    bgColor2: "bg-orange-500/10",
  },
  variety: {
    name: "综艺",
    emoji: "🎤",
    icon: <Clapperboard className="w-5 h-5 text-yellow-400" />,
    gradient: "from-yellow-500/5 via-transparent to-orange-500/5",
    bgColor1: "bg-yellow-500/10",
    bgColor2: "bg-orange-500/10",
  },
  documentary: {
    name: "纪录片",
    emoji: "📚",
    icon: <BookOpen className="w-5 h-5 text-cyan-400" />,
    gradient: "from-cyan-500/5 via-transparent to-blue-500/5",
    bgColor1: "bg-cyan-500/10",
    bgColor2: "bg-blue-500/10",
  },
};

export default function CategoryPage() {
  const router = useRouter();
  const params = useParams();
  const categoryType = params.type as string;

  // 使用影片点击 hook
  const { handleMovieClick, toast, setToast } = useMovieMatch();

  // 使用 SWR 缓存的分类数据 hook
  const { movies, loading, loadingMore, error, hasMore, loadMore, refetch } =
    useCategoryData(categoryType);

  const config = CATEGORY_CONFIG[categoryType] || {
    name: "影视列表",
    emoji: "🎬",
    icon: <Film className="w-5 h-5" />,
    gradient: "from-gray-500/5 via-transparent to-gray-500/5",
    bgColor1: "bg-gray-500/10",
    bgColor2: "bg-gray-500/10",
  };

  // 滚动位置恢复（等待加载完成后恢复）
  useScrollRestoration(`category-${categoryType}`, {
    delay: 100,
    enabled: !loading,
  });

  const goBack = () => {
    router.push("/");
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
          </div>
        </div>
      </nav>

      {/* Hero 区域 */}
      <div className="relative pt-24 pb-6 px-4 md:px-12 overflow-hidden">
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
          <div className="flex items-center gap-4">
            <div className="text-2xl md:text-4xl">{config.emoji}</div>
            <h1 className="text-4xl md:text-4xl font-bold text-white mb-2 tracking-tight">
              {config.name}
            </h1>
          </div>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="px-4 md:px-12 pb-16">
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
                onClick={refetch}
                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors shadow-lg shadow-red-600/20"
              >
                重新加载
              </button>
            </div>
          </div>
        ) : movies.length === 0 ? (
          <div className="flex items-center justify-center py-32">
            <div className="text-center">
              <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4">
                <Film className="w-10 h-10 text-gray-600" />
              </div>
              <h3 className="text-xl font-bold text-white mb-2">暂无内容</h3>
              <p className="text-gray-400 mb-6">该分类暂无影片数据</p>
              <button
                onClick={goBack}
                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                返回首页
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 gap-3 md:gap-4 lg:gap-5">
              {movies.map((movie) => (
                <div
                  key={movie.id}
                  className="transform transition-all duration-300 hover:scale-105"
                >
                  <DoubanCard movie={movie} onSelect={handleMovieClick} />
                </div>
              ))}
            </div>

            {/* 加载更多区域 */}
            {hasMore && categoryType !== "top250" && (
              <div className="flex justify-center mt-12">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="flex items-center gap-2 px-8 py-4 bg-white/5 hover:bg-white/10 disabled:bg-white/5 text-white rounded-xl font-medium transition-all border border-white/10 hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>加载中...</span>
                    </>
                  ) : (
                    <>
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                      <span>加载更多</span>
                    </>
                  )}
                </button>
              </div>
            )}

            {/* 没有更多了 */}
            {!hasMore && movies.length > 0 && (
              <div className="text-center mt-12 text-gray-500">
                <div className="inline-flex items-center gap-2 px-6 py-3 bg-white/5 rounded-xl">
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <span>已加载全部 {movies.length} 部影片</span>
                </div>
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
