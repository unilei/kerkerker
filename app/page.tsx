"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, HardDrive } from "lucide-react";
import type { DoubanMovie } from "@/types/douban";
import type { NewApiMovie } from "@/types/home";
import { Toast } from "@/components/Toast";

// Hooks
import { useScrollState } from "@/hooks/useScrollState";
import { useHomeData } from "@/hooks/useHomeData";
import { useMovieMatch } from "@/hooks/useMovieMatch";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";

// Components
import { Navbar } from "@/components/home/Navbar";
import { SearchModal } from "@/components/home/SearchModal";
import { LoadingSkeleton } from "@/components/home/LoadingSkeleton";
import { ErrorState } from "@/components/home/ErrorState";
import { EmptyState } from "@/components/home/EmptyState";
import { HeroBanner } from "@/components/home/HeroBanner";
import { CategoryRow } from "@/components/home/CategoryRow";
import { Footer } from "@/components/home/Footer";

// Utils
import { getCategoryIcon, getCategoryPath } from "@/lib/utils/category-icons";
import { SEARCH_SITE_URL } from "@/lib/seo";
import { useLocale } from "@/components/providers/locale-provider";

function categoryHref(category: { key?: string; name: string }): string {
  switch (category.key) {
    case "movies":
      return "/browse/movies";
    case "series":
      return "/browse/tv";
    case "latest":
    case "latest-movies":
    case "latest-series":
      return "/browse/latest";
    case "top250":
      return "/category/top250";
    default:
      return `/category/${getCategoryPath(category.name)}`;
  }
}

export default function HomePage() {
  const router = useRouter();
  const [showSearch, setShowSearch] = useState(false);
  const { locale } = useLocale();
  const isEnglish = locale === "en-US";

  // 使用自定义 hooks
  const scrolled = useScrollState(50);
  const { categories, heroMovies, heroDataList, loading, error, refetch } =
    useHomeData();
  const { handleMovieClick, toast, setToast } = useMovieMatch();

  // 滚动位置恢复（导航返回时保持位置）
  useScrollRestoration("home", { delay: 100 });

  return (
    <div className="min-h-screen bg-black">
      {/* 导航栏 */}
      <Navbar scrolled={scrolled} onSearchOpen={() => setShowSearch(true)} />

      {/* 搜索弹窗 */}
      <SearchModal isOpen={showSearch} onClose={() => setShowSearch(false)} />

      {/* 加载状态 */}
      {loading ? (
        <LoadingSkeleton />
      ) : error ? (
        /* 错误状态 */
        <ErrorState error={error} onRetry={refetch} />
      ) : heroMovies.length === 0 && categories.length === 0 ? (
        /* 空状态 - 只有当所有数据都为空时才显示 */
        <EmptyState onRetry={refetch} />
      ) : (
        <>
          {/* Hero Banner */}
          <HeroBanner
            heroMovies={heroMovies}
            heroDataList={heroDataList}
            onMovieClick={handleMovieClick}
          />

          <section
            className="px-4 md:px-12"
            aria-label={isEnglish ? "Cloud drive search" : "网盘搜索入口"}
          >
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-y border-white/10 py-5">
              <div className="flex items-center gap-3 text-white">
                <HardDrive className="h-5 w-5 text-red-500" aria-hidden="true" />
                <span className="text-sm font-medium md:text-base">
                  {isEnglish ? "Cloud drive search" : "网盘搜索入口"}
                </span>
              </div>
              <a
                href={SEARCH_SITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-red-500/50 bg-red-600/10 px-4 text-sm font-semibold text-red-200 transition-colors hover:bg-red-600/20 hover:text-white"
              >
                <span>{isEnglish ? "Open cloud search" : "打开网盘搜索"}</span>
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </section>

          {/* 分类列表区域 */}
          <div className="relative z-20 space-y-10 md:space-y-12 lg:space-y-16 pb-16">

            {/* 渲染所有新 API 返回的分类 */}
            {categories.length > 0
              ? categories.map((category, index) => {
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
                        router.push(categoryHref(category))
                      }
                    />
                  );
                })
              : null}
          </div>
        </>
      )}

      {/* 匹配中遮罩 */}
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
