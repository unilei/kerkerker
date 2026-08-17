"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Star,
  Clock,
  MapPin,
  Users,
  Clapperboard,
  ImageIcon,
  MessageCircle,
  Film,
  FileText,
} from "lucide-react";
import Link from "next/link";
import { getImageUrl } from "@/lib/utils/image-utils";
import { loadMovieCache } from "@/hooks/useMovieMatch";
import { PanResourceSection } from "@/components/movie/PanResourceSection";

// 完整的电影详情
interface MovieDetail {
  id: string;
  internal_id?: number;
  title: string; // 完整标题（含外文名/年份）用于显示
  cover: string;
  rate: string;
  types: string[];
  directors: string[];
  actors: string[];
  duration: string;
  region: string;
  release_year: string;
  episodes_count: string;
  description?: string; // 剧情简介全文（豆瓣 v:summary）
  short_comment?: {
    content: string;
    author: string | { name: string };
  };
  // 新增字段 - 来自增强的API
  photos?: Array<{
    id: string;
    image: string;
    thumb: string;
  }>;
  comments?: Array<{
    id: string;
    content: string;
    author: {
      name: string;
    };
  }>;
  recommendations?: Array<{
    id: string;
    title: string;
    cover: string;
    rate: string;
  }>;
}


export default function MovieDetailPage() {
  const params = useParams();
  const router = useRouter();

  const doubanId = params.id as string;

  // 电影详情状态
  const [movieDetail, setMovieDetail] = useState<MovieDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(true);
  // 剧情简介展开/收起
  const [introExpanded, setIntroExpanded] = useState(false);

  // 智能返回：如果有历史记录则返回，否则跳转首页
  const goBack = useCallback(() => {
    // window.history.length > 2 表示有可返回的历史（1是初始页面，2是当前页面）
    if (window.history.length > 2) {
      router.back();
    } else {
      router.push("/");
    }
  }, [router]);

  // 获取电影详情：优先缓存快速显示，API 补充详细信息
  useEffect(() => {
    // 1. 立即从缓存加载数据（快速显示）
    const cached = loadMovieCache(doubanId);
    if (cached) {
      setMovieDetail({
        id: cached.id,
        title: cached.title,
        cover: cached.cover,
        rate: cached.rate,
        types: [],
        directors: [],
        actors: [],
        duration: "",
        region: "",
        release_year: "",
        episodes_count: cached.episode_info || "",
      });
      setIsLoadingDetail(false); // 有缓存立即结束加载状态
    }

    // 2. 异步请求 API 补充详细信息
    const fetchApiDetail = async () => {
      try {
        const { getSubjectDetail } = await import("@/lib/douban-service");
        const apiData = await getSubjectDetail(doubanId);
        if (apiData && apiData.id) {
          // 用 API 数据补充缓存没有的字段，缓存字段优先
          setMovieDetail((prev) => {
            const cachedData = prev || ({} as MovieDetail);
            return {
              id: cachedData.id || apiData.id,
              internal_id: apiData.internal_id ?? cachedData.internal_id,
              title: cachedData.title || apiData.title,
              // 封面：缓存优先，但如果缓存是空的则用API的
              cover: cachedData.cover || apiData.cover || "",
              rate: cachedData.rate || apiData.rate || "",
              // 以下字段缓存通常没有，用 API 补充
              types: apiData.types || cachedData.types || [],
              directors: apiData.directors || cachedData.directors || [],
              actors: apiData.actors || cachedData.actors || [],
              duration: apiData.duration || cachedData.duration || "",
              region: apiData.region || cachedData.region || "",
              release_year:
                apiData.release_year || cachedData.release_year || "",
              episodes_count:
                cachedData.episodes_count || apiData.episodes_count || "",
              description: apiData.description || cachedData.description,
              short_comment: apiData.short_comment || cachedData.short_comment,
              // 新增字段
              photos: apiData.photos || [],
              comments: apiData.comments || [],
              recommendations: apiData.recommendations || [],
            };
          });
        }
      } catch (error) {
        console.warn("API 获取详情失败:", error);
      } finally {
        setIsLoadingDetail(false);
      }
    };

    if (doubanId) {
      fetchApiDetail();
    }
  }, [doubanId]);

  // 便捷访问
  const title = movieDetail?.title || "";
  const cover = movieDetail?.cover || "";
  const rate = movieDetail?.rate || "";

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-red-500/30">
      {/* 沉浸式背景 - 调整透明度以保持整体暗黑风格一致性 */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 bg-[#0a0a0a] z-0" />
        <img
          src={getImageUrl(cover)}
          alt={title}
          className="absolute inset-0 w-full h-full object-cover opacity-20 blur-3xl scale-110"
        />
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
              <span className="text-red-600">爱盼</span>
              <span className="text-white ml-1">详情</span>
            </h1>
          </div>
        </div>
      </nav>

      {/* 加载中骨架屏 */}
      {isLoadingDetail && (
        <main className="relative z-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
          <div className="flex flex-col lg:flex-row gap-12 items-start">
            {/* 海报骨架 */}
            <div className="w-full max-w-[300px] mx-auto lg:w-[360px] shrink-0">
              <div className="aspect-2/3 rounded-2xl bg-white/10 animate-pulse shadow-2xl shadow-black/50" />
            </div>

            {/* 信息骨架 */}
            <div className="flex-1 w-full space-y-6">
              {/* 标题 */}
              <div className="space-y-3">
                <div className="h-10 md:h-14 bg-white/10 rounded-xl w-3/4 animate-pulse" />
              </div>

              {/* 评分和标签行 */}
              <div className="flex flex-wrap gap-3">
                <div className="h-9 w-20 bg-yellow-500/10 rounded-lg animate-pulse" />
                <div className="h-9 w-16 bg-white/10 rounded-lg animate-pulse delay-75" />
                <div className="h-9 w-24 bg-white/10 rounded-lg animate-pulse delay-100" />
                <div className="h-9 w-20 bg-white/10 rounded-lg animate-pulse delay-150" />
              </div>

              {/* 类型标签 */}
              <div className="flex gap-2">
                <div className="h-7 w-16 bg-red-500/10 rounded-full animate-pulse" />
                <div className="h-7 w-14 bg-red-500/10 rounded-full animate-pulse delay-75" />
                <div className="h-7 w-18 bg-red-500/10 rounded-full animate-pulse delay-100" />
              </div>

              {/* 导演/演员 */}
              <div className="space-y-3">
                <div className="flex gap-2 items-center">
                  <div className="h-4 w-12 bg-white/5 rounded animate-pulse" />
                  <div className="h-4 w-40 bg-white/10 rounded animate-pulse delay-75" />
                </div>
                <div className="flex gap-2 items-center">
                  <div className="h-4 w-12 bg-white/5 rounded animate-pulse" />
                  <div className="h-4 w-64 bg-white/10 rounded animate-pulse delay-100" />
                </div>
              </div>

              {/* 短评骨架 */}
              <div className="bg-white/5 rounded-xl p-4 space-y-2 animate-pulse">
                <div className="h-4 bg-white/10 rounded w-full" />
                <div className="h-4 bg-white/10 rounded w-5/6" />
                <div className="h-3 bg-white/5 rounded w-24 mt-3" />
              </div>
            </div>
          </div>
        </main>
      )}

      {/* 主内容 */}
      {!isLoadingDetail && (
        <main className="relative z-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
          <div className="flex flex-col lg:flex-row gap-12 items-start">
            {/* 左侧海报 */}
            <div className="w-full max-w-[300px] mx-auto lg:w-[360px] shrink-0 animate-fade-in">
              <div className="aspect-2/3 rounded-2xl overflow-hidden shadow-2xl shadow-black/80 border border-white/10 relative group">
                <img
                  src={getImageUrl(cover)}
                  alt={title}
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-linear-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              </div>
            </div>

            {/* 右侧信息 */}
            <div className="flex-1 w-full animate-fade-in delay-100">
              {/* 标题和元数据 */}
              <div className="mb-10">
                <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight tracking-tight drop-shadow-xl">
                  {title}
                </h1>

                {/* 评分和基本标签 */}
                <div className="flex flex-wrap items-center gap-3 text-sm md:text-base mb-6">
                  {rate && (
                    <div className="flex items-center gap-1.5 bg-yellow-500/20 text-yellow-400 px-3 py-1.5 rounded-lg border border-yellow-500/20 backdrop-blur-sm shadow-sm">
                      <Star className="w-4 h-4 fill-current" />
                      <span className="font-bold">{rate}</span>
                    </div>
                  )}
                  {movieDetail?.release_year && (
                    <div className="px-3 py-1.5 bg-white/10 rounded-lg text-gray-200 backdrop-blur-sm border border-white/5">
                      {movieDetail.release_year}
                    </div>
                  )}
                  {movieDetail?.duration && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 rounded-lg text-gray-200 backdrop-blur-sm border border-white/5">
                      <Clock className="w-3.5 h-3.5" />
                      {movieDetail.duration}
                    </div>
                  )}
                  {movieDetail?.region && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 rounded-lg text-gray-200 backdrop-blur-sm border border-white/5">
                      <MapPin className="w-3.5 h-3.5" />
                      {movieDetail.region}
                    </div>
                  )}
                  {movieDetail?.episodes_count && (
                    <div className="px-3 py-1.5 bg-blue-500/20 text-blue-300 rounded-lg border border-blue-500/20">
                      {movieDetail.episodes_count}
                    </div>
                  )}
                </div>

                {/* 类型标签 */}
                {movieDetail?.types && movieDetail.types.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-6">
                    {movieDetail.types.map((type, idx) => (
                      <span
                        key={idx}
                        className="px-3 py-1 bg-red-500/20 text-red-300 rounded-full text-sm border border-red-500/20"
                      >
                        {type}
                      </span>
                    ))}
                  </div>
                )}

                {/* 导演和演员 */}
                <div className="space-y-3 mb-6">
                  {movieDetail?.directors &&
                    movieDetail.directors.length > 0 && (
                      <div className="flex items-start gap-2 text-sm">
                        <span className="text-gray-500 shrink-0 flex items-center gap-1">
                          <Clapperboard className="w-4 h-4" />
                          导演:
                        </span>
                        <span className="text-gray-300">
                          {movieDetail.directors.join(" / ")}
                        </span>
                      </div>
                    )}
                  {movieDetail?.actors && movieDetail.actors.length > 0 && (
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-gray-500 shrink-0 flex items-center gap-1">
                        <Users className="w-4 h-4" />
                        主演:
                      </span>
                      <span className="text-gray-300 line-clamp-2">
                        {movieDetail.actors.slice(0, 5).join(" / ")}
                      </span>
                    </div>
                  )}
                </div>

                {/* 剧情简介 */}
                {movieDetail?.description && (
                  <div className="mb-6">
                    <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                      <FileText className="w-5 h-5 text-blue-400" />
                      剧情简介
                    </h3>
                    <p
                      className={`text-gray-300 text-sm leading-relaxed whitespace-pre-line ${
                        introExpanded ? "" : "line-clamp-4"
                      }`}
                    >
                      {movieDetail.description}
                    </p>
                    {movieDetail.description.length > 120 && (
                      <button
                        onClick={() => setIntroExpanded((v) => !v)}
                        className="mt-2 text-xs text-gray-500 hover:text-red-400 transition-colors"
                      >
                        {introExpanded ? "收起" : "展开全部"}
                      </button>
                    )}
                  </div>
                )}

                {/* 短评 */}
                {movieDetail?.short_comment && (
                  <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                    <p className="text-gray-300 text-sm italic leading-relaxed">
                      &ldquo;{movieDetail.short_comment.content}&rdquo;
                    </p>
                    <p className="text-gray-500 text-xs mt-2">
                      ——{" "}
                      {typeof movieDetail.short_comment.author === "string"
                        ? movieDetail.short_comment.author
                        : movieDetail.short_comment.author?.name}
                    </p>
                  </div>
                )}

                {/* 剧照 */}
                {movieDetail?.photos && movieDetail.photos.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                      <ImageIcon className="w-5 h-5 text-blue-400" />
                      剧照
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                      {movieDetail.photos.slice(0, 6).map((photo) => (
                        <a
                          key={photo.id}
                          href={photo.image}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="aspect-video rounded-lg overflow-hidden bg-white/5 hover:opacity-80 transition-opacity"
                        >
                          <img
                            src={getImageUrl(photo.thumb || photo.image)}
                            alt="剧照"
                            className="w-full h-full object-cover"
                          />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {/* 热门短评 */}
                {movieDetail?.comments && movieDetail.comments.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                      <MessageCircle className="w-5 h-5 text-green-400" />
                      热门短评
                    </h3>
                    <div className="space-y-3">
                      {movieDetail.comments.slice(0, 3).map((comment) => (
                        <div
                          key={comment.id}
                          className="bg-white/5 rounded-lg p-3 border border-white/5"
                        >
                          <p className="text-gray-300 text-sm leading-relaxed line-clamp-3">
                            {comment.content}
                          </p>
                          <p className="text-gray-500 text-xs mt-2">
                            —— {comment.author.name}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 网盘资源 */}
          <PanResourceSection
            doubanId={doubanId}
            title={movieDetail?.title}
            internalId={movieDetail?.internal_id}
          />

          {/* 相关推荐 */}
          {movieDetail?.recommendations &&
            movieDetail.recommendations.length > 0 && (
              <div className="mt-12">
                <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
                  <Film className="w-6 h-6 text-red-500" />
                  相关推荐
                </h2>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-4">
                  {movieDetail.recommendations.map((rec) => (
                    <Link
                      key={rec.id}
                      href={`/movie/${rec.id}`}
                      className="group"
                    >
                      <div className="aspect-2/3 rounded-xl overflow-hidden bg-white/5 mb-2 border border-white/5 group-hover:border-red-500/50 transition-colors">
                        <img
                          src={getImageUrl(rec.cover)}
                          alt={rec.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      </div>
                      <h3 className="text-sm text-white font-medium line-clamp-1 group-hover:text-red-400 transition-colors">
                        {rec.title}
                      </h3>
                      {rec.rate && (
                        <div className="flex items-center gap-1 text-xs text-yellow-400 mt-1">
                          <Star className="w-3 h-3 fill-current" />
                          {rec.rate}
                        </div>
                      )}
                    </Link>
                  ))}
                </div>
              </div>
            )}
        </main>
      )}
    </div>
  );
}
