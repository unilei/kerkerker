"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Play, Star, Loader2, AlertCircle, RefreshCw, Clock, MapPin, Users, Clapperboard } from "lucide-react";
import Link from "next/link";
import { getImageUrl } from "@/lib/utils/image-utils";
import { cleanTitleForSearch } from "@/lib/utils/title-utils";
import { loadMovieCache } from "@/hooks/useMovieMatch";

interface AvailableSource {
  source_key: string;
  source_name: string;
  vod_id: string | number;
  vod_name: string;
  match_confidence: "high" | "medium" | "low";
}

interface CachedMatchData {
  douban_id: string;
  title: string;
  matches: AvailableSource[];
  timestamp: number;
}

// 完整的电影详情
interface MovieDetail {
  id: string;
  title: string;        // 完整标题（含外文名/年份）用于显示
  searchTitle: string;  // 简短标题用于搜索
  cover: string;
  rate: string;
  types: string[];
  directors: string[];
  actors: string[];
  duration: string;
  region: string;
  release_year: string;
  episodes_count: string;
  short_comment?: {
    content: string;
    author: string;
  };
}

type SearchStatus = "idle" | "searching" | "success" | "error" | "not_found";

export default function MovieDetailPage() {
  const params = useParams();
  const router = useRouter();
  
  const doubanId = params.id as string;
  
  // 电影详情状态
  const [movieDetail, setMovieDetail] = useState<MovieDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(true);

  // 获取电影详情：优先缓存快速显示，API 补充详细信息
  useEffect(() => {
    // 1. 立即从缓存加载数据（快速显示）
    const cached = loadMovieCache(doubanId);
    if (cached) {
      setMovieDetail({
        id: cached.id,
        title: cached.title,
        searchTitle: cached.title, // 缓存的是简短标题
        cover: cached.cover,
        rate: cached.rate,
        types: [],
        directors: [],
        actors: [],
        duration: '',
        region: '',
        release_year: '',
        episodes_count: cached.episode_info || '',
      });
      setIsLoadingDetail(false); // 有缓存立即结束加载状态
    }
    
    // 2. 异步请求 API 补充详细信息
    const fetchApiDetail = async () => {
      try {
        const response = await fetch(`/api/douban/detail/${doubanId}`);
        if (response.ok) {
          const apiData = await response.json();
          if (apiData.id) {
            // 用 API 数据补充缓存没有的字段，缓存字段优先
            setMovieDetail(prev => {
              const cachedData = prev || {} as MovieDetail;
              return {
                id: cachedData.id || apiData.id,
                title: cachedData.title || apiData.title,
                searchTitle: cachedData.searchTitle || cleanTitleForSearch(apiData.title),
                // 封面：缓存优先，但如果缓存是空的则用API的
                cover: cachedData.cover || apiData.cover || '',
                rate: cachedData.rate || apiData.rate || '',
                // 以下字段缓存通常没有，用 API 补充
                types: apiData.types || cachedData.types || [],
                directors: apiData.directors || cachedData.directors || [],
                actors: apiData.actors || cachedData.actors || [],
                duration: apiData.duration || cachedData.duration || '',
                region: apiData.region || cachedData.region || '',
                release_year: apiData.release_year || cachedData.release_year || '',
                episodes_count: cachedData.episodes_count || apiData.episodes_count || '',
                short_comment: apiData.short_comment || cachedData.short_comment,
              };
            });
          }
        }
      } catch (error) {
        console.warn('API 获取详情失败:', error);
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
  const searchTitle = movieDetail?.searchTitle || "";  // 用于搜索的简短标题
  const cover = movieDetail?.cover || "";
  const rate = movieDetail?.rate || "";

  // 搜索状态
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [availableSources, setAvailableSources] = useState<AvailableSource[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [searchedSourceCount, setSearchedSourceCount] = useState<number>(0);
  const [totalSourceCount, setTotalSourceCount] = useState<number>(0);

  // 流式搜索播放源 - 每个源完成立即显示
  const searchPlaySources = useCallback(async (forceRefresh = false) => {
    // 检查缓存
    if (!forceRefresh) {
      try {
        const cached = localStorage.getItem("multi_source_matches");
        if (cached) {
          const data: CachedMatchData = JSON.parse(cached);
          // 缓存有效期 30 分钟，且是同一部影片
          if (
            data.douban_id === doubanId &&
            Date.now() - data.timestamp < 30 * 60 * 1000 &&
            data.matches.length > 0
          ) {
            setAvailableSources(data.matches);
            setSearchStatus("success");
            return;
          }
        }
      } catch {
        // 缓存读取失败，继续搜索
      }
    }

    // 开始流式搜索
    setSearchStatus("searching");
    setErrorMessage("");
    setAvailableSources([]);
    setSearchedSourceCount(0);
    setTotalSourceCount(0);

    try {
      // 使用简短标题搜索，提高匹配率
      const response = await fetch(
        `/api/douban/match-vod-stream?title=${encodeURIComponent(searchTitle)}&douban_id=${doubanId}`
      );

      if (!response.ok) {
        throw new Error('搜索请求失败');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('无法读取响应流');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const allMatches: AvailableSource[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 数据
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'init') {
                setTotalSourceCount(data.totalSources);
              } else if (data.type === 'result') {
                setSearchedSourceCount(data.completed);
                
                // 如果找到匹配，立即添加到列表
                if (data.match) {
                  allMatches.push(data.match);
                  // 按置信度排序：high > medium > low
                  const sorted = [...allMatches].sort((a, b) => {
                    const order = { high: 3, medium: 2, low: 1 };
                    return order[b.match_confidence] - order[a.match_confidence];
                  });
                  setAvailableSources(sorted);
                  
                  // 只要找到第一个源，就切换到 success 状态
                  if (allMatches.length === 1) {
                    setSearchStatus("success");
                  }
                }
              } else if (data.type === 'done') {
                // 搜索完成
                if (allMatches.length > 0) {
                  // 缓存结果
                  localStorage.setItem(
                    "multi_source_matches",
                    JSON.stringify({
                      douban_id: doubanId,
                      title: searchTitle,
                      matches: allMatches,
                      timestamp: Date.now(),
                    })
                  );
                  // 确保状态为成功
                  setSearchStatus("success");
                } else {
                  setSearchStatus("not_found");
                  setErrorMessage(`已搜索 ${data.totalSources} 个视频源，未找到匹配内容`);
                }
              }
            } catch (e) {
              console.error('解析 SSE 数据失败:', e);
            }
          }
        }
      }
    } catch (error) {
      setSearchStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "搜索播放源时出错");
    }
  }, [doubanId, searchTitle]);

  // 组件挂载时自动搜索
  useEffect(() => {
    let isMounted = true;
    
    const doSearch = async () => {
      if (doubanId && searchTitle && isMounted) {
        await searchPlaySources();
      }
    };
    
    doSearch();
    
    return () => {
      isMounted = false;
    };
  }, [doubanId, searchTitle, searchPlaySources]);

  // 播放
  const handlePlay = (source: AvailableSource) => {
    router.push(`/play/${source.vod_id}?source=${source.source_key}&multi=true`);
  };

  // 快速播放（使用第一个源）
  const handleQuickPlay = () => {
    if (availableSources.length > 0) {
      handlePlay(availableSources[0]);
    }
  };

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
            <Link
              href="/"
              className="p-2 -ml-2 rounded-full hover:bg-white/10 transition-colors group"
            >
              <ArrowLeft className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors" />
            </Link>
            <h1 
              className="text-xl font-bold tracking-tight cursor-pointer hidden sm:block"
              onClick={() => router.push('/')}
            >
              <span className="text-red-600">壳儿</span>
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
              
              {/* 播放源区域骨架 */}
              <div className="bg-white/5 rounded-3xl p-6 mt-8 space-y-4">
                <div className="flex justify-between items-center">
                  <div className="h-6 w-20 bg-white/10 rounded animate-pulse" />
                  <div className="h-4 w-28 bg-white/5 rounded animate-pulse" />
                </div>
                <div className="h-12 w-36 bg-red-500/20 rounded-full mx-auto animate-pulse" />
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="h-16 bg-white/5 rounded-xl animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
                  ))}
                </div>
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

          {/* 右侧信息 & 播放源 */}
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
                    <span key={idx} className="px-3 py-1 bg-red-500/20 text-red-300 rounded-full text-sm border border-red-500/20">
                      {type}
                    </span>
                  ))}
                </div>
              )}

              {/* 导演和演员 */}
              <div className="space-y-3 mb-6">
                {movieDetail?.directors && movieDetail.directors.length > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <span className="text-gray-500 shrink-0 flex items-center gap-1">
                      <Clapperboard className="w-4 h-4" />
                      导演:
                    </span>
                    <span className="text-gray-300">{movieDetail.directors.join(' / ')}</span>
                  </div>
                )}
                {movieDetail?.actors && movieDetail.actors.length > 0 && (
                  <div className="flex items-start gap-2 text-sm">
                    <span className="text-gray-500 shrink-0 flex items-center gap-1">
                      <Users className="w-4 h-4" />
                      主演:
                    </span>
                    <span className="text-gray-300 line-clamp-2">{movieDetail.actors.slice(0, 5).join(' / ')}</span>
                  </div>
                )}
              </div>

              {/* 短评 */}
              {movieDetail?.short_comment && (
                <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                  <p className="text-gray-300 text-sm italic leading-relaxed">&ldquo;{movieDetail.short_comment.content}&rdquo;</p>
                  <p className="text-gray-500 text-xs mt-2">—— {movieDetail.short_comment.author}</p>
                </div>
              )}
            </div>

            {/* 播放源区域 */}
            <div className="bg-[#121212]/40 backdrop-blur-2xl rounded-3xl border border-white/5 p-6 md:p-8 shadow-2xl shadow-black/20">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-white flex items-center gap-3">
                  <span className="w-1 h-6 bg-red-600 rounded-full"/>
                  播放源
                  {searchStatus === "searching" && totalSourceCount > 0 && (
                    <span className="text-sm font-normal text-gray-400 ml-2 flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      正在搜索... {searchedSourceCount}/{totalSourceCount}
                    </span>
                  )}
                </h2>
                
                {/* 统计信息 */}
                {(availableSources.length > 0) && (
                  <div className="text-sm text-gray-400 bg-black/20 px-3 py-1 rounded-full border border-white/5">
                    已找到 <span className="text-white font-bold">{availableSources.length}</span> 个可用源
                  </div>
                )}
              </div>

              {/* 搜索中且无结果 */}
              {searchStatus === "searching" && availableSources.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-3">
                  <Loader2 className="w-8 h-8 animate-spin text-red-500" />
                  <span>正在全网搜索资源...</span>
                </div>
              )}

              {/* 有结果 */}
              {(searchStatus === "success" || (searchStatus === "searching" && availableSources.length > 0)) && (
                <div className="space-y-8">
                  {/* 快速播放 */}
                  <button
                    onClick={handleQuickPlay}
                    className="w-full md:w-auto flex items-center justify-center gap-3 bg-red-600 hover:bg-red-500 text-white px-10 py-4 rounded-2xl font-bold text-lg transition-all hover:scale-[1.02] active:scale-[0.98] shadow-xl shadow-red-900/20 group"
                  >
                    <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                      <Play className="w-4 h-4 fill-red-600 text-red-600 ml-0.5" />
                    </div>
                    立即播放
                  </button>

                  {/* 列表 */}
                  <div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
                      {availableSources.map((source, index) => (
                        <button
                          key={`${source.source_key}-${source.vod_id}`}
                          onClick={() => handlePlay(source)}
                          className={`relative p-4 rounded-xl text-left transition-all duration-300 group border ${
                            index === 0
                              ? "bg-red-500/10 border-red-500/30 hover:bg-red-500/20 hover:border-red-500/50"
                              : "bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/10"
                          }`}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                              index === 0 ? "bg-red-500/20 text-red-300" : "bg-white/10 text-gray-400 group-hover:text-white"
                            }`}>
                              {source.source_name}
                            </span>
                            {source.match_confidence === "high" && (
                              <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded-full border border-green-500/20">
                                精确
                              </span>
                            )}
                          </div>
                          <div className="font-medium text-white text-sm line-clamp-1 group-hover:text-red-400 transition-colors">
                            {source.vod_name}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* 未找到 */}
              {searchStatus === "not_found" && (
                <div className="flex flex-col items-center justify-center py-12 gap-4">
                  <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center">
                    <AlertCircle className="w-8 h-8 text-gray-500" />
                  </div>
                  <div className="text-center">
                    <p className="text-white font-medium mb-1">未找到匹配资源</p>
                    <p className="text-sm text-gray-500">{errorMessage}</p>
                  </div>
                  <button
                    onClick={() => searchPlaySources(true)}
                    className="mt-2 px-6 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm text-gray-300 hover:text-white transition-colors border border-white/5 flex items-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" />
                    重新搜索
                  </button>
                </div>
              )}

              {/* 错误状态 */}
              {searchStatus === "error" && (
                <div className="flex flex-col items-center justify-center py-12 gap-4">
                  <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center">
                    <AlertCircle className="w-8 h-8 text-red-500" />
                  </div>
                  <div className="text-center">
                    <p className="text-white font-medium mb-1">搜索出错</p>
                    <p className="text-sm text-gray-500">{errorMessage}</p>
                  </div>
                  <button
                    onClick={() => searchPlaySources(true)}
                    className="mt-2 px-6 py-2 bg-red-600 hover:bg-red-500 rounded-full text-sm text-white transition-colors shadow-lg shadow-red-900/20 flex items-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" />
                    重试
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
      )}
    </div>
  );
}
