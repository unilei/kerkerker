"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Layers } from "lucide-react";
import Link from "next/link";
import { useLocale } from "@/components/providers/locale-provider";
import { LanguageSwitcher } from "@/components/home/LanguageSwitcher";
import { ShortDramaPanSection, ShortDramaIntro } from "@/components/short-drama/ShortDramaPanSection";

/**
 * 短剧详情页：复刻影片详情页的沉浸式布局（左侧海报 + 右侧信息 +
 * 底部网盘资源区），数据来自 /api/short-dramas/:id（转存完成的条目）。
 */

interface DramaDetail {
  id: string;
  title: string;
  episode_count?: number;
  tags: string[];
  cover_url?: string;
  intro?: string;
  own_share_url?: string;
  own_share_code?: string;
  publish_date?: string;
  metadata?: Record<string, unknown>;
}

export default function DramaDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { locale } = useLocale();
  const isEnglish = locale === "en-US";

  const [detail, setDetail] = useState<DramaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const goBack = useCallback(() => {
    if (window.history.length > 2) {
      router.back();
    } else {
      router.push("/");
    }
  }, [router]);

  useEffect(() => {
    const id = params.id as string;
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
    fetch(`/api/short-dramas/${encodeURIComponent(id)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
        const response = await fetch(`/api/short-dramas/${encodeURIComponent(id)}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        if (cancelled) return;
        if (response.status === 404) {
          setNotFound(true);
          return;
        }
        const payload = (await response.json()) as { code: number; data?: DramaDetail };
        if (payload.code === 200 && payload.data) {
          setDetail(payload.data);
        } else {
          setNotFound(true);
        }
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  const title = detail?.title || "";

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-red-500/30">
      {/* 沉浸式背景 */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 bg-[#0a0a0a] z-0" />
        {detail?.cover_url && (
          <img
            src={detail.cover_url}
            alt={title}
            className="absolute inset-0 w-full h-full object-cover opacity-20 blur-3xl scale-110"
          />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-[#0a0a0a] via-[#0a0a0a]/80 to-transparent z-10" />
        <div className="absolute inset-0 bg-linear-to-r from-[#0a0a0a] via-[#0a0a0a]/60 to-transparent z-10" />
      </div>

      {/* 导航栏 */}
      <nav className="sticky top-0 left-0 right-0 z-50 bg-[#0a0a0a]/95 backdrop-blur-xl border-b border-white/5 shadow-2xl shadow-black/50">
        <div className="max-w-[2000px] mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center gap-4">
            <button
              onClick={goBack}
              className="p-2 -ml-2 rounded-full hover:bg-white/10 transition-colors group"
            >
              <ArrowLeft className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors" />
            </button>
            <h1
              className="text-xl font-bold tracking-tight cursor-pointer hidden sm:block"
              onClick={goBack}
            >
              <span className="text-red-600">爱盼短剧</span>
              <span className="text-white ml-1">{isEnglish ? "Detail" : "详情"}</span>
            </h1>
            <LanguageSwitcher compact />
          </div>
        </div>
      </nav>

      {/* 加载骨架 */}
      {loading && (
        <main className="relative z-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
          <div className="flex flex-col lg:flex-row gap-12 items-start">
            <div className="w-full max-w-[300px] mx-auto lg:w-[360px] shrink-0">
              <div className="aspect-2/3 rounded-2xl bg-white/10 animate-pulse shadow-2xl shadow-black/50" />
            </div>
            <div className="flex-1 w-full space-y-6">
              <div className="h-10 md:h-14 bg-white/10 rounded-xl w-3/4 animate-pulse" />
              <div className="flex flex-wrap gap-3">
                <div className="h-9 w-20 bg-white/10 rounded-lg animate-pulse" />
                <div className="h-9 w-16 bg-white/10 rounded-lg animate-pulse delay-75" />
                <div className="h-9 w-24 bg-white/10 rounded-lg animate-pulse delay-100" />
              </div>
              <div className="flex gap-2">
                <div className="h-7 w-16 bg-red-500/10 rounded-full animate-pulse" />
                <div className="h-7 w-14 bg-red-500/10 rounded-full animate-pulse delay-75" />
              </div>
            </div>
          </div>
        </main>
      )}

      {/* 未找到 */}
      {!loading && (notFound || !detail) && (
        <main className="relative z-20 max-w-6xl mx-auto px-4 py-24 text-center">
          <p className="text-gray-400 text-lg mb-6">
            {isEnglish ? "Drama not available yet." : "短剧不存在或资源尚未就绪"}
          </p>
          <Link
            href="/"
            className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-full text-sm font-medium transition-colors"
          >
            {isEnglish ? "Back to home" : "回到首页"}
          </Link>
        </main>
      )}

      {/* 主内容 */}
      {!loading && detail && (
        <main className="relative z-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
          <div className="flex flex-col lg:flex-row gap-12 items-start">
            {/* 左侧海报 */}
            <div className="w-full max-w-[300px] mx-auto lg:w-[360px] shrink-0 animate-fade-in">
              <div className="aspect-2/3 rounded-2xl overflow-hidden shadow-2xl shadow-black/80 border border-white/10 relative group bg-white/5">
                {detail.cover_url ? (
                  <img
                    src={detail.cover_url}
                    alt={title}
                    className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600">
                    <Layers className="w-16 h-16" />
                  </div>
                )}
                <div className="absolute inset-0 bg-linear-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              </div>
            </div>

            {/* 右侧信息 */}
            <div className="flex-1 w-full animate-fade-in delay-100">
              <div className="mb-10">
                <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight tracking-tight drop-shadow-xl">
                  {title}
                </h1>

                {/* 元数据标签行 */}
                <div className="flex flex-wrap items-center gap-3 text-sm md:text-base mb-6">
                  {detail.episode_count ? (
                    <div className="px-3 py-1.5 bg-blue-500/20 text-blue-300 rounded-lg border border-blue-500/20 flex items-center gap-1.5">
                      <Layers className="w-4 h-4" />
                      {detail.episode_count} 集
                    </div>
                  ) : null}
                  {detail.publish_date && (
                    <div className="px-3 py-1.5 bg-white/10 rounded-lg text-gray-200 backdrop-blur-sm border border-white/5">
                      {detail.publish_date}
                    </div>
                  )}
                </div>

                {/* 标签 */}
                {detail.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-6">
                    {detail.tags.map((tag) => (
                      <Link
                        key={tag}
                        href={`/?tag=${encodeURIComponent(tag)}`}
                        className="px-3 py-1 bg-red-500/20 text-red-300 rounded-full text-sm border border-red-500/20 hover:bg-red-500/30 transition-colors"
                      >
                        {tag}
                      </Link>
                    ))}
                  </div>
                )}

                {/* 简介 */}
                {detail.intro && <ShortDramaIntro intro={detail.intro} />}
              </div>
            </div>
          </div>

          {/* 网盘资源 */}
          {detail.own_share_url && (
            <ShortDramaPanSection
              shareUrl={detail.own_share_url}
              shareCode={detail.own_share_code}
              episodeCount={detail.episode_count}
            />
          )}
        </main>
      )}
    </div>
  );
}
