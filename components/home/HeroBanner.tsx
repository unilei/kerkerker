import { useState, useEffect } from "react";
import { Play, ChevronLeft, ChevronRight } from "lucide-react";
import type { DoubanMovie } from "@/types/douban";
import type { HeroData } from "@/types/home";
import { getImageUrl } from "@/lib/utils/image-utils";

interface HeroBannerProps {
  heroMovies: DoubanMovie[];
  heroDataList: HeroData[];
  onMovieClick: (movie: DoubanMovie) => void;
}

export function HeroBanner({ heroMovies, heroDataList, onMovieClick }: HeroBannerProps) {
  const [currentHeroIndex, setCurrentHeroIndex] = useState(0);

  // 自动轮播
  useEffect(() => {
    if (heroMovies.length <= 1) return;

    const timer = setInterval(() => {
      setCurrentHeroIndex((prevIndex) => (prevIndex + 1) % heroMovies.length);
    }, 5000); // 每5秒切换一次

    return () => clearInterval(timer);
  }, [heroMovies.length]);

  // 手动切换
  const goToHero = (index: number) => {
    setCurrentHeroIndex(index);
  };

  const goToPrevHero = () => {
    setCurrentHeroIndex((prevIndex) => 
      prevIndex === 0 ? heroMovies.length - 1 : prevIndex - 1
    );
  };

  const goToNextHero = () => {
    setCurrentHeroIndex((prevIndex) => 
      (prevIndex + 1) % heroMovies.length
    );
  };

  if (heroMovies.length === 0 || heroDataList.length === 0) {
    return <HeroBannerSkeleton />;
  }

  return (
    <div className="relative w-full group">
      {/* 海报容器 - 使用固定宽高比 */}
      <div className="relative w-full aspect-[3/4] md:aspect-[12/5] overflow-hidden">
        {/* 轮播图片 */}
        {heroMovies.map((movie, index) => {
          const heroData = heroDataList[index];
          const isActive = index === currentHeroIndex;
          
          return (
            <div
              key={movie.id}
              className={`absolute inset-0 transition-opacity duration-700 ${
                isActive ? 'opacity-100 z-10' : 'opacity-0 z-0'
              }`}
            >
              {/* 移动端：9:16 竖向海报 */}
              <img
                src={getImageUrl(heroData.poster_vertical)}
                alt={movie.title}
                className="block md:hidden absolute inset-0 w-full h-full object-cover bg-black"
              />

              {/* PC端：16:9 横向海报 */}
              <img
                src={getImageUrl(heroData.poster_horizontal)}
                alt={movie.title}
                className="hidden md:block absolute inset-0 w-full h-full object-cover bg-black"
              />

              {/* 渐变遮罩 */}
              <div className="absolute inset-0 bg-gradient-to-t md:bg-gradient-to-r from-black/95 via-black/70 md:via-black/50 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent" />

              {/* 内容 */}
              <div className="absolute inset-0 flex items-end">
                <div className="w-full px-4 md:px-12 pb-8 md:pb-12 lg:pb-16">
                  <div className="max-w-3xl">
                    <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-3 md:mb-4 leading-tight drop-shadow-2xl">
                      {movie.title}
                    </h1>

                    {/* 评分、类型和剧集信息 */}
                    <div className="flex flex-wrap items-center gap-2 mb-3 md:mb-4">
                      {movie.rate && (
                        <div className="flex items-center space-x-1 text-yellow-400 bg-black/40 px-2.5 py-1 rounded-full backdrop-blur-sm">
                          <svg
                            className="w-4 h-4"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                          <span className="font-bold text-sm">
                            {movie.rate}
                          </span>
                        </div>
                      )}

                      {heroData.genres && heroData.genres.length > 0 && (
                        <>
                          {heroData.genres.slice(0, 3).map((genre: string, idx: number) => (
                            <span
                              key={idx}
                              className="text-xs text-gray-200 bg-white/10 px-2.5 py-1 rounded-full backdrop-blur-sm"
                            >
                              {genre}
                            </span>
                          ))}
                        </>
                      )}

                      {movie.episode_info && (
                        <span className="text-xs text-gray-200 bg-white/10 px-2.5 py-1 rounded-full backdrop-blur-sm">
                          {movie.episode_info}
                        </span>
                      )}
                    </div>

                    {/* 电影描述 - 仅PC端显示 */}
                    {heroData.description && (
                      <p className="hidden md:block text-sm text-gray-200 mb-4 line-clamp-2 leading-relaxed max-w-2xl">
                        {heroData.description}
                      </p>
                    )}

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => onMovieClick(movie)}
                        className="flex items-center gap-2 bg-white text-black px-6 md:px-8 py-3 md:py-3.5 rounded-lg font-bold hover:bg-opacity-90 hover:scale-105 transition-all duration-200 text-sm md:text-base shadow-2xl"
                      >
                        <Play className="w-5 h-5 md:w-6 md:h-6 fill-current" />
                        <span>立即播放</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* 左右导航按钮 - 仅悬停时显示 */}
        <button
          onClick={goToPrevHero}
          className="hidden md:flex absolute left-4 top-1/2 -translate-y-1/2 z-20 w-12 h-12 items-center justify-center bg-black/50 hover:bg-black/70 text-white rounded-full backdrop-blur-sm transition-all duration-300 hover:scale-110 opacity-0 group-hover:opacity-100"
          aria-label="上一个"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
        <button
          onClick={goToNextHero}
          className="hidden md:flex absolute right-4 top-1/2 -translate-y-1/2 z-20 w-12 h-12 items-center justify-center bg-black/50 hover:bg-black/70 text-white rounded-full backdrop-blur-sm transition-all duration-300 hover:scale-110 opacity-0 group-hover:opacity-100"
          aria-label="下一个"
        >
          <ChevronRight className="w-6 h-6" />
        </button>

        {/* 指示器 */}
        <div className="absolute hidden md:flex bottom-6 left-1/2 -translate-x-1/2 z-20 items-center gap-2">
          {heroMovies.map((_, index) => (
            <button
              key={index}
              onClick={() => goToHero(index)}
              className={`transition-all duration-300 ${
                index === currentHeroIndex
                  ? 'w-8 h-2 bg-white'
                  : 'w-2 h-2 bg-white/50 hover:bg-white/75'
              } rounded-full`}
              aria-label={`跳转到第 ${index + 1} 个`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Hero Banner 骨架屏组件
function HeroBannerSkeleton() {
  return (
    <div className="relative w-full aspect-[9/16] md:aspect-[16/9] overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-black animate-pulse">
      {/* 渐变遮罩 */}
      <div className="absolute inset-0 bg-gradient-to-t md:bg-gradient-to-r from-black/95 via-black/70 md:via-black/50 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent" />
      
      {/* 内容骨架 */}
      <div className="absolute inset-0 flex items-end">
        <div className="w-full px-4 md:px-12 pb-8 md:pb-12 lg:pb-24">
          <div className="max-w-3xl space-y-4">
            {/* 标题骨架 */}
            <div className="h-12 md:h-16 bg-gray-700/50 rounded-lg w-3/4 animate-pulse" />
            
            {/* 标签骨架 */}
            <div className="flex gap-2">
              <div className="h-6 w-16 bg-gray-700/50 rounded-full animate-pulse" />
              <div className="h-6 w-20 bg-gray-700/50 rounded-full animate-pulse" />
              <div className="h-6 w-24 bg-gray-700/50 rounded-full animate-pulse" />
            </div>
            
            {/* 描述骨架 */}
            <div className="hidden md:block space-y-2">
              <div className="h-4 bg-gray-700/50 rounded w-full animate-pulse" />
              <div className="h-4 bg-gray-700/50 rounded w-5/6 animate-pulse" />
            </div>
            
            {/* 按钮骨架 */}
            <div className="h-12 w-36 bg-gray-700/50 rounded-lg animate-pulse" />
          </div>
        </div>
      </div>
      
      {/* 指示器骨架 */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="w-2 h-2 bg-gray-700/50 rounded-full animate-pulse" />
        ))}
      </div>
    </div>
  );
}
