"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import type { DoubanMovie } from "@/types/douban";
import type { NewApiMovie } from "@/types/home";
import { Toast } from "@/components/Toast";

// Hooks
import { useScrollState } from "@/hooks/useScrollState";
import { useHomeData } from "@/hooks/useHomeData";
import { useMovieMatch } from "@/hooks/useMovieMatch";

// Components
import { Navbar } from "@/components/home/Navbar";
import { SearchModal } from "@/components/home/SearchModal";
import { LoadingSkeleton } from "@/components/home/LoadingSkeleton";
import { ErrorState } from "@/components/home/ErrorState";
import { EmptyState } from "@/components/home/EmptyState";
import { HeroBanner } from "@/components/home/HeroBanner";
import { CategoryRow } from "@/components/home/CategoryRow";
import { LoadingOverlay } from "@/components/home/LoadingOverlay";
import { Footer } from "@/components/home/Footer";

// Utils
import { getCategoryIcon, getCategoryPath } from "@/lib/utils/category-icons";

export default function HomePage() {
  const router = useRouter();
  const [showSearch, setShowSearch] = useState(false);

  // 使用自定义 hooks
  const scrolled = useScrollState(50);
  const { categories, top250Movies, heroMovies, heroDataList, loading, error, refetch } = useHomeData();
  const { matchingMovie, handleMovieClick, toast, setToast } = useMovieMatch();

  return (
    <div className="min-h-screen bg-black">
      {/* 导航栏 */}
      <Navbar 
        scrolled={scrolled} 
        onSearchOpen={() => setShowSearch(true)} 
      />

      {/* 搜索弹窗 */}
      <SearchModal
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
      />

      {/* 加载状态 */}
      {loading ? (
        <LoadingSkeleton />
      ) : error ? (
        /* 错误状态 */
        <ErrorState error={error} onRetry={refetch} />
      ) : categories.length === 0 && top250Movies.length === 0 ? (
        /* 空状态 */
        <EmptyState onRetry={refetch} />
      ) : (
        <>
          {/* Hero Banner */}
          <HeroBanner
            heroMovies={heroMovies}
            heroDataList={heroDataList}
            onMovieClick={handleMovieClick}
          />

          {/* 分类列表区域 */}
          <div className="relative z-20 mt-6 sm:-mt-4 md:-mt-4 lg:-mt-4 space-y-10 md:space-y-12 lg:space-y-16 pb-16">
            {/* 渲染所有新 API 返回的分类 */}
            {categories.length > 0 ? (
              categories.map((category, index) => {
                // 转换数据格式为 DoubanMovie
                const movies: DoubanMovie[] = category.data.map(
                  (item: NewApiMovie) => ({
                    id: item.id,
                    title: item.title,
                    cover: item.cover || "",
                    url: item.url || "",
                    rate: item.rate || "",
                    episode_info: (item.episode_info as string) || "",
                    cover_x: (item.cover_x as number) || 0,
                    cover_y: (item.cover_y as number) || 0,
                    playable: (item.playable as boolean) || false,
                    is_new: (item.is_new as boolean) || false,
                  })
                );

                return (
                  <CategoryRow
                    key={index}
                    title={category.name}
                    icon={getCategoryIcon(category.name)}
                    movies={movies}
                    onMovieClick={handleMovieClick}
                    onViewMore={() =>
                      router.push(`/category/${getCategoryPath(category.name)}`)
                    }
                  />
                );
              })
            ) : (
              /* 分类占位符 */
              <div className="px-4 md:px-12 text-center py-12">
                <div className="inline-flex items-center space-x-2 text-gray-500 bg-gray-900/50 px-6 py-4 rounded-lg">
                  <svg
                    className="w-6 h-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                  </svg>
                  <span>暂无可用分类</span>
                </div>
              </div>
            )}

            {/* 豆瓣 Top 250 */}
            {top250Movies.length > 0 && (
              <CategoryRow
                title="豆瓣 Top 250"
                icon={<Star className="w-5 h-5 fill-current text-yellow-500" />}
                movies={top250Movies}
                onMovieClick={handleMovieClick}
                onViewMore={() => router.push("/category/top250")}
              />
            )}
          </div>
        </>
      )}

      {/* 匹配中遮罩 */}
      {matchingMovie && <LoadingOverlay />}

      {/* Toast 通知 */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* Footer */}
      <Footer />
    </div>
  );
}
