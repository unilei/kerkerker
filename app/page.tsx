"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useScrollState } from "@/hooks/useScrollState";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { Navbar } from "@/components/home/Navbar";
import { Footer } from "@/components/home/Footer";
import { LoadingSkeleton } from "@/components/home/LoadingSkeleton";
import { ErrorState } from "@/components/home/ErrorState";
import { EmptyState } from "@/components/home/EmptyState";
import ShortDramaCard from "@/components/short-drama/ShortDramaCard";
import { SearchModal } from "@/components/short-drama/SearchModal";

interface DramaListItem {
  id: string;
  title: string;
  episode_count?: number;
  tags: string[];
  cover_url?: string;
  updated_at: string;
}

interface ListResponse {
  code: number;
  data?: {
    dramas: DramaListItem[];
    total: number;
    page: number;
    limit: number;
  };
}

const PAGE_SIZE = 24;

function HomePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showSearch, setShowSearch] = useState(false);
  const scrolled = useScrollState(50);

  // 列表状态
  const [dramas, setDramas] = useState<DramaListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 标签：URL ?tag= 为准；搜索为本地状态（一次性）
  const activeTag = searchParams.get("tag") || undefined;
  const [search, setSearch] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const activeRequest = useRef(0);

  useScrollRestoration("home", { delay: 100 });

  const loadPage = useCallback(
    async (targetPage: number, append: boolean) => {
      const requestId = ++activeRequest.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          limit: String(PAGE_SIZE),
        });
        if (activeTag) params.set("tag", activeTag);
        if (search) params.set("search", search);
        const response = await fetch(`/api/short-dramas?${params.toString()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        const payload = (await response.json()) as ListResponse;
        if (requestId !== activeRequest.current) return;
        if (payload.code === 200 && payload.data) {
          setDramas((prev) =>
            append ? [...prev, ...payload.data!.dramas] : payload.data!.dramas
          );
          setTotal(payload.data.total);
          setPage(payload.data.page);
          setHasMore(payload.data.page * payload.data.limit < payload.data.total);
        } else {
          setError("短剧列表加载失败");
        }
      } catch (fetchError) {
        if (requestId !== activeRequest.current) return;
        console.warn("短剧列表加载失败:", fetchError);
        setError("网络异常，请稍后重试");
      } finally {
        if (requestId === activeRequest.current) setLoading(false);
      }
    },
    [activeTag, search]
  );

  useEffect(() => {
    loadPage(1, false);
  }, [loadPage]);

  const handleTagSelect = useCallback(
    (tag: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (tag) params.set("tag", tag);
      else params.delete("tag");
      router.push(`/?${params.toString()}`, { scroll: true });
    },
    [router, searchParams]
  );

  const handleSearch = useCallback(
    (keyword: string) => {
      setShowSearch(false);
      // 搜索语义是全局找剧：清掉标签筛选，否则 search+tag 组合几乎必然空结果
      const params = new URLSearchParams(searchParams.toString());
      params.delete("tag");
      params.delete("view");
      router.push(`/?${params.toString()}`, { scroll: true });
      setSearch(keyword);
    },
    [router, searchParams]
  );

  return (
    <div className="min-h-screen bg-black">
      <Navbar scrolled={scrolled} onSearchOpen={() => setShowSearch(true)} />

      {showSearch && (
        <SearchModal onClose={() => setShowSearch(false)} onSearch={handleSearch} />
      )}

      <main className="relative z-10 pt-24 px-4 md:px-12 pb-8">
        {/* 头部标语 */}
        <div className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold text-white">
            {activeTag ? (
              <>
                标签：<span className="text-red-500">{activeTag}</span>
                <button
                  onClick={() => handleTagSelect(null)}
                  className="ml-3 text-sm text-gray-400 hover:text-white underline underline-offset-4"
                >
                  清除筛选
                </button>
              </>
            ) : search ? (
              <>
                搜索：<span className="text-red-500">{search}</span>
                <button
                  onClick={() => setSearch(null)}
                  className="ml-3 text-sm text-gray-400 hover:text-white underline underline-offset-4"
                >
                  清除
                </button>
              </>
            ) : (
              "精选短剧合集"
            )}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            共 {total} 部 · 短剧信息与网盘资源导航
          </p>
        </div>

        {/* 加载骨架 */}
        {loading && dramas.length === 0 && <LoadingSkeleton />}

        {/* 错误态 */}
        {!loading && error && dramas.length === 0 && (
          <ErrorState error={error} onRetry={() => loadPage(1, false)} />
        )}

        {/* 空态 */}
        {!loading && !error && dramas.length === 0 && (
          <EmptyState onRetry={() => loadPage(1, false)} />
        )}

        {/* 海报墙 */}
        {dramas.length > 0 && (
          <>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 md:gap-4">
              {dramas.map((drama, index) => (
                <ShortDramaCard key={drama.id} drama={drama} priority={index < 8} />
              ))}
            </div>

            {/* 加载更多 */}
            {hasMore && (
              <div className="mt-10 flex justify-center">
                <button
                  onClick={() => loadPage(page + 1, true)}
                  disabled={loading}
                  className="px-6 py-3 bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white rounded-full text-sm font-medium transition-colors"
                >
                  {loading ? "加载中…" : "加载更多"}
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-black">
          <LoadingSkeleton />
        </div>
      }
    >
      <HomePageContent />
    </Suspense>
  );
}
