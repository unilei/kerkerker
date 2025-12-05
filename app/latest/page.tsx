'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Film, Sparkles, FastForward, Plus, Trophy, Flame } from 'lucide-react';
import DoubanCard from '@/components/DoubanCard';
import { DoubanMovie } from '@/types/douban';

interface NewApiMovie {
  id: string;
  title: string;
  rate: string;
  cover: string;
  url: string;
  [key: string]: unknown;
}

interface CategoryData {
  name: string;
  data: NewApiMovie[];
}

export default function LatestPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matchingMovie, setMatchingMovie] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/douban/latest');
      
      if (!response.ok) {
        throw new Error('数据加载失败');
      }

      const result = await response.json();

      if (result.code === 200 && result.data) {
        setCategories(result.data);
      }
    } catch (error) {
      console.error('加载数据失败:', error);
      setError(error instanceof Error ? error.message : '数据加载失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleMovieClick = async (movie: DoubanMovie) => {
    setMatchingMovie(movie.id);
    try {
      const response = await fetch('/api/douban/match-vod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          douban_id: movie.id,
          title: movie.title,
        }),
      });

      const result = await response.json();
      
      if (result.code === 200 && result.data?.matches && result.data.matches.length > 0) {
        const matches = result.data.matches;
        
        localStorage.setItem('multi_source_matches', JSON.stringify({
          douban_id: movie.id,
          title: movie.title,
          matches: matches,
          timestamp: Date.now(),
        }));
        
        const firstMatch = matches[0];
        router.push(`/play/${firstMatch.vod_id}?source=${firstMatch.source_key}&multi=true`);
      } else {
        alert(`未在任何播放源中找到《${movie.title}》\n\n已搜索 ${result.data?.total_sources || 9} 个视频源`);
      }
    } catch (error) {
      console.error('搜索播放源失败:', error);
      alert('搜索播放源时出错，请重试');
    } finally {
      setMatchingMovie(null);
    }
  };

  const goBack = () => {
    router.push('/');
  };

  const getCategoryIcon = (name: string): React.JSX.Element => {
    const iconClass = "w-5 h-5";
    const iconMap: Record<string, React.JSX.Element> = {
      '院线新片': <Film className={`${iconClass} text-blue-500`} />,
      '最新电影': <Sparkles className={`${iconClass} text-yellow-400`} />,
      '即将上映': <FastForward className={`${iconClass} text-green-500`} />,
      '新剧上线': <Plus className={`${iconClass} text-purple-500`} />,
      '本周口碑榜': <Trophy className={`${iconClass} text-yellow-500 fill-current`} />,
      '热门趋势': <Flame className={`${iconClass} text-orange-500`} />,
    };
    return iconMap[name] || <Plus className={iconClass} />;
  };

  return (
    <div className="min-h-screen bg-linear-to-b from-black via-gray-950 to-black text-white">
      {/* 顶部导航栏 */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-black/90 backdrop-blur-md border-b border-gray-800/50">
        <div className="px-4 md:px-12 py-5">
          <div className="flex items-center justify-between">
            <button
              onClick={goBack}
              className="flex items-center gap-2 text-white/80 hover:text-white transition-all group"
            >
              <div className="p-1.5 rounded-full bg-white/5 group-hover:bg-white/10 transition-colors">
                <svg className="w-5 h-5 group-hover:-translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </div>
              <span className="text-sm md:text-base font-medium">返回</span>
            </button>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight bg-linear-to-r from-red-600 to-red-500 bg-clip-text text-transparent">壳儿</h1>
          </div>
        </div>
      </nav>

      {/* Hero 区域 */}
      <div className="relative pt-24 pb-12 px-4 md:px-12 overflow-hidden">
        {/* 装饰性背景 */}
        <div className="absolute inset-0 bg-linear-to-r from-green-500/5 via-transparent to-blue-500/5" />
        <div className="absolute top-0 right-0 w-96 h-96 bg-green-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl" />
        
        <div className="relative">
          <div className="flex items-center gap-4 mb-4">
            <div className="text-5xl md:text-6xl">🆕</div>
            <div>
              <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold text-white mb-2 tracking-tight">
                最新
              </h1>
              <p className="text-lg text-gray-400">
                {loading ? '正在加载最新内容...' : `探索 ${categories.length} 个精选分类`}
              </p>
            </div>
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
                onClick={fetchData}
                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors shadow-lg shadow-red-600/20"
              >
                重新加载
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-16">
            {categories.map((category, index) => {
              const movies: DoubanMovie[] = category.data.map((item: NewApiMovie) => ({
                id: item.id,
                title: item.title,
                cover: item.cover || '',
                url: item.url || '',
                rate: item.rate || '',
                episode_info: (item.episode_info as string) || '',
                cover_x: (item.cover_x as number) || 0,
                cover_y: (item.cover_y as number) || 0,
                playable: (item.playable as boolean) || false,
                is_new: (item.is_new as boolean) || false,
              }));

              return (
                <div key={index} className="group">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-2xl md:text-3xl font-bold text-white flex items-center gap-3">
                      <span className="text-3xl">{getCategoryIcon(category.name)}</span>
                      <span className="bg-linear-to-r from-white to-gray-400 bg-clip-text text-transparent">
                        {category.name}
                      </span>
                    </h2>
                    <div className="text-sm text-gray-500">
                      {movies.length} 部
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4 lg:gap-5">
                    {movies.map((movie) => (
                      <div key={movie.id} className="transform transition-all duration-300 hover:scale-105">
                        <DoubanCard
                          movie={movie}
                          onSelect={handleMovieClick}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 匹配中遮罩 */}
      {matchingMovie && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-700 border-t-red-600 mx-auto mb-4" />
            <p className="text-white text-lg">正在匹配播放源...</p>
            <p className="text-gray-400 text-sm mt-2">正在搜索所有可用播放源</p>
          </div>
        </div>
      )}
    </div>
  );
}
