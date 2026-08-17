"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DoubanMovie } from "@/types/douban";
import DoubanCard from "@/components/DoubanCard";
import { useMovieMatch } from "@/hooks/useMovieMatch";
import {
  searchDouban,
  type SuggestItem,
  type Subject,
} from "@/lib/douban-service";

function SearchSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-y-8 gap-x-4 animate-pulse">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="space-y-3">
          <div className="aspect-2/3 bg-gray-800/50 rounded-lg w-full" />
          <div className="space-y-2">
            <div className="h-4 bg-gray-800/50 rounded w-3/4" />
            <div className="h-3 bg-gray-800/50 rounded w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

// 将豆瓣搜索结果统一映射为卡片数据
function toMovie(item: SuggestItem | Subject): DoubanMovie {
  const suggest = item as SuggestItem;
  const advanced = item as Subject;
  return {
    id: String(item.id),
    title: item.title,
    cover: suggest.img || advanced.cover || "",
    rate: advanced.rate || "",
    episode_info: suggest.episode || advanced.episode_info || "",
    is_new: false,
    playable: false,
    url: item.url,
    cover_x: 0,
    cover_y: 0,
  };
}

function SearchContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryKeyword = searchParams.get("q") || "";
  const { handleMovieClick } = useMovieMatch();

  const [searchKeyword, setSearchKeyword] = useState(queryKeyword);
  const [searchResults, setSearchResults] = useState<DoubanMovie[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // 同步 URL 参数到本地搜索框状态
  useEffect(() => {
    setSearchKeyword(queryKeyword);
  }, [queryKeyword]);

  // 执行豆瓣搜索
  useEffect(() => {
    if (!queryKeyword.trim()) return;

    let cancelled = false;
    const performSearch = async () => {
      setLoading(true);
      setSearched(true);
      try {
        const data = await searchDouban(queryKeyword.trim());
        if (cancelled) return;
        const items: DoubanMovie[] = (data.suggest?.length
          ? data.suggest
          : data.advanced || []
        ).map(toMovie);
        setSearchResults(items);
      } catch (error) {
        console.error("搜索失败:", error);
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    performSearch();
    return () => {
      cancelled = true;
    };
  }, [queryKeyword]);

  // 处理搜索提交
  const handleSearch = () => {
    if (!searchKeyword.trim()) return;
    router.push(`/search?q=${encodeURIComponent(searchKeyword.trim())}`);
  };

  // 返回首页
  const goBack = () => {
    router.push("/");
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white selection:bg-red-500/30">
      {/* 顶部导航栏 */}
      <div className="sticky top-0 left-0 right-0 z-50 bg-[#0a0a0a]/95 backdrop-blur-xl border-b border-white/5 shadow-2xl shadow-black/50">
        <div className="max-w-[2000px] mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center gap-4">
            {/* 返回按钮和Logo */}
            <div className="flex items-center gap-4 shrink-0">
              <button
                onClick={goBack}
                className="p-2 -ml-2 rounded-full hover:bg-white/10 transition-colors group"
              >
                <svg
                  className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors"
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
              </button>
              <h1
                className="text-xl font-bold tracking-tight cursor-pointer hidden sm:block"
                onClick={goBack}
              >
                <span className="text-red-600">爱盼</span>
                <span className="text-white ml-1">搜索</span>
              </h1>
            </div>
            {/* 搜索框 */}
            <div className="flex-1 max-w-2xl mx-auto">
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <svg
                    className="w-5 h-5 text-gray-500 group-focus-within:text-red-500 transition-colors"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                <input
                  type="text"
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="搜索电影、电视剧、动漫..."
                  className="w-full bg-white/5 border border-white/10 rounded-full py-2.5 pl-12 pr-12 text-sm md:text-base text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500/50 focus:bg-white/10 transition-all"
                  autoFocus
                />
                {searchKeyword && (
                  <button
                    onClick={() => setSearchKeyword("")}
                    className="absolute inset-y-0 right-14 pr-2 flex items-center"
                  >
                    <svg
                      className="w-4 h-4 text-gray-500 hover:text-white transition-colors"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                )}
                <button
                  onClick={handleSearch}
                  className="absolute inset-y-0 right-1.5 my-1.5 px-4 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-full transition-colors shadow-lg shadow-red-900/20"
                >
                  搜索
                </button>
              </div>
            </div>
            <div className="w-10 sm:w-[88px] shrink-0" />{" "}
            {/* Spacer for alignment */}
          </div>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="max-w-[2000px] mx-auto px-4 sm:px-6 lg:px-8 py-8 min-h-[60vh]">
        {/* 状态反馈条 */}
        {(loading || searched) && (
          <div className="mb-8 flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 text-gray-400">
              {loading ? (
                <>
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  正在搜索...
                </>
              ) : (
                <>
                  <span className="text-white font-medium">
                    {searchResults.length}
                  </span>{" "}
                  个结果
                  {queryKeyword && (
                    <>
                      · 关键词{" "}
                      <span className="text-white font-medium">
                        &ldquo;{queryKeyword}&rdquo;
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 结果展示 */}
        {loading && searchResults.length === 0 ? (
          // 初始加载中 (Skeleton)
          <SearchSkeleton />
        ) : searched || searchResults.length > 0 ? (
          searchResults.length > 0 ? (
            <div className="animate-fade-in">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-y-8 gap-x-4">
                {searchResults.map((movie) => (
                  <DoubanCard
                    key={movie.id}
                    movie={movie}
                    onSelect={handleMovieClick}
                  />
                ))}
              </div>
            </div>
          ) : (
            /* 无结果 */
            <div className="flex flex-col items-center justify-center py-32">
              <div className="w-24 h-24 bg-gray-900 rounded-full flex items-center justify-center mb-6">
                <svg
                  className="w-12 h-12 text-gray-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-white mb-2">
                未找到相关内容
              </h3>
              <p className="text-gray-400 mb-6">
                搜索 &ldquo;{queryKeyword}&rdquo; 没有结果，换个关键词试试
              </p>
              <div className="flex items-center space-x-4">
                <button
                  onClick={goBack}
                  className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
                >
                  返回首页
                </button>
                <button
                  onClick={() => setSearchKeyword("")}
                  className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
                >
                  重新搜索
                </button>
              </div>
            </div>
          )
        ) : (
          /* 初始状态 */
          <div className="flex flex-col items-center justify-center py-32">
            <div className="w-24 h-24 bg-gray-900 rounded-full flex items-center justify-center mb-6">
              <svg
                className="w-12 h-12 text-gray-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-white mb-2">搜索影视信息</h3>
            <p className="text-gray-400">输入关键词，查找影片信息与网盘资源</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-black text-white flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-700 border-t-red-600 mx-auto mb-4" />
            <p className="text-gray-300 text-lg font-medium">加载中...</p>
          </div>
        </div>
      }
    >
      <SearchContent />
    </Suspense>
  );
}
