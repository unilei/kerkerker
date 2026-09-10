"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Layers } from "lucide-react";
import Link from "next/link";
import { useLocale } from "@/components/providers/locale-provider";
import { LanguageSwitcher } from "@/components/home/LanguageSwitcher";
import { Footer } from "@/components/home/Footer";
import { ShortDramaPanSection, ShortDramaIntro } from "@/components/short-drama/ShortDramaPanSection";
import ShortDramaCard, {
  type ShortDramaCardData,
} from "@/components/short-drama/ShortDramaCard";
import { tagPath } from "@/lib/seo";

/**
 * 短剧详情视图：复刻影片详情页的沉浸式布局（左侧海报 + 右侧信息 +
 * 底部网盘资源区）。数据由服务端组件取好传入（SEO 首屏直出），
 * 组件本身只负责交互（返回、语言切换）与展示。
 */

export interface DramaDetailViewData {
  id: string;
  title: string;
  episode_count?: number;
  tags: string[];
  cover_url?: string;
  intro?: string;
  share_url?: string;
  share_code?: string;
  publish_date?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
  /** 同标签相关短剧（服务端取好直出：内链 + 蜘蛛纵深） */
  related?: ShortDramaCardData[];
}

export default function DramaDetailView({ drama }: { drama: DramaDetailViewData }) {
  const router = useRouter();
  const { locale } = useLocale();
  const isEnglish = locale === "en-US";

  const goBack = useCallback(() => {
    // 只要历史栈里还有上一条就 back：首页翻页状态在 URL（?page=N）里，
    // 返回即可还原第 N 页。history.length 是包含当前页的总数，
    // 新标签页「首页→详情」时为 2，用 >2 会误判成无处可退。
    if (window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }, [router]);

  const title = drama.title;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-red-500/30">
      {/* 沉浸式背景 */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 bg-[#0a0a0a] z-0" />
        {drama.cover_url && (
          <img
            src={drama.cover_url}
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
            <div
              className="text-xl font-bold tracking-tight cursor-pointer hidden sm:block"
              onClick={goBack}
            >
              <span className="text-red-600">爱盼短剧</span>
              <span className="text-white ml-1">{isEnglish ? "Detail" : "详情"}</span>
            </div>
            <LanguageSwitcher compact />
          </div>
        </div>
      </nav>

      {/* 主内容 */}
      <main className="relative z-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        <div className="flex flex-col lg:flex-row gap-12 items-start">
          {/* 左侧海报 */}
          <div className="w-full max-w-[300px] mx-auto lg:w-[360px] shrink-0 animate-fade-in">
            <div className="aspect-2/3 rounded-2xl overflow-hidden shadow-2xl shadow-black/80 border border-white/10 relative group bg-white/5">
              {drama.cover_url ? (
                <img
                  src={drama.cover_url}
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
                {drama.episode_count ? (
                  <div className="px-3 py-1.5 bg-blue-500/20 text-blue-300 rounded-lg border border-blue-500/20 flex items-center gap-1.5">
                    <Layers className="w-4 h-4" />
                    {drama.episode_count} 集
                  </div>
                ) : null}
                {drama.publish_date && (
                  <div className="px-3 py-1.5 bg-white/10 rounded-lg text-gray-200 backdrop-blur-sm border border-white/5">
                    {drama.publish_date}
                  </div>
                )}
              </div>

              {/* 标签 */}
              {drama.tags.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-6">
                  {drama.tags.map((tag) => (
                    <Link
                      key={tag}
                      href={tagPath(tag)}
                      className="px-3 py-1 bg-red-500/20 text-red-300 rounded-full text-sm border border-red-500/20 hover:bg-red-500/30 transition-colors"
                    >
                      {tag}
                    </Link>
                  ))}
                </div>
              )}

              {/* 简介 */}
              {drama.intro && (
                <ShortDramaIntro intro={drama.intro} metadata={drama.metadata} />
              )}
            </div>
          </div>
        </div>

        {/* 网盘资源 */}
        {drama.share_url && (
          <ShortDramaPanSection
            shareUrl={drama.share_url}
            shareCode={drama.share_code}
            episodeCount={drama.episode_count}
          />
        )}

        {/* 相关短剧：服务端直出的同标签推荐（SEO 内链 + 浏览纵深） */}
        {drama.related && drama.related.length > 0 && (
          <section className="mt-16 border-t border-white/10 pt-10">
            <h2 className="text-lg md:text-xl font-bold text-white mb-6">
              相关短剧推荐
            </h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 md:gap-4">
              {drama.related.map((related) => (
                <ShortDramaCard key={related.id} drama={related} priority={false} />
              ))}
            </div>
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
