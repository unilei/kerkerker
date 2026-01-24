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

export function HeroBanner({
  heroMovies,
  heroDataList,
  onMovieClick,
}: HeroBannerProps) {
  const [currentHeroIndex, setCurrentHeroIndex] = useState(0);

  // 自动轮播 - 页面不可见时暂停
  useEffect(() => {
    if (heroMovies.length <= 1) return;

    let timer: NodeJS.Timeout;

    const startTimer = () => {
      timer = setInterval(() => {
        setCurrentHeroIndex((prevIndex) => (prevIndex + 1) % heroMovies.length);
      }, 5000);
    };

    const stopTimer = () => {
      clearInterval(timer);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopTimer();
      } else {
        startTimer();
      }
    };

    startTimer();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
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
    setCurrentHeroIndex((prevIndex) => (prevIndex + 1) % heroMovies.length);
  };

  if (heroMovies.length === 0 || heroDataList.length === 0) {
    return <HeroBannerSkeleton />;
  }

  return (
    <div className="relative w-full group">
      {/* 海报容器 - 使用固定宽高比 */}
      <div className="relative w-full aspect-3/4 md:aspect-12/5 overflow-hidden">
        {/* 轮播图片 */}
        {heroMovies.map((movie, index) => {
          const heroData = heroDataList[index];
          const isActive = index === currentHeroIndex;

          return (
            <div
              key={movie.id}
              className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${
                isActive ? "opacity-100 z-10" : "opacity-0 z-0"
              }`}
            >
              {/* 背景图层 */}
              <div className="absolute inset-0">
                {/* 移动端：9:16 竖向海报 */}
                <img
                  src={getImageUrl(heroData.poster_vertical)}
                  alt={movie.title}
                  // 首张图片优先加载，其他懒加载
                  loading={index === 0 ? "eager" : "lazy"}
                  fetchPriority={index === 0 ? "high" : "auto"}
                  decoding="async"
                  className="block md:hidden w-full h-full object-cover"
                />

                {/* PC端：16:9 横向海报 */}
                <img
                  src={getImageUrl(heroData.poster_horizontal)}
                  alt={movie.title}
                  // 首张图片优先加载，其他懒加载
                  loading={index === 0 ? "eager" : "lazy"}
                  fetchPriority={index === 0 ? "high" : "auto"}
                  decoding="async"
                  className="hidden md:block w-full h-full object-cover object-top"
                />

                {/* 智能遮罩系统 */}
                <div className="absolute inset-0 bg-linear-to-t from-black via-black/60 to-transparent opacity-90" />
                <div className="absolute inset-0 bg-linear-to-r from-black/80 via-black/40 to-transparent hidden md:block" />
              </div>

              {/* 内容区域 */}
              <div className="absolute inset-0 flex items-end">
                <div className="w-full px-4 md:px-12 lg:px-16 pb-20 md:pb-24">
                  <div
                    className={`max-w-3xl transform transition-all duration-700 delay-100 ${
                      isActive
                        ? "translate-y-0 opacity-100"
                        : "translate-y-8 opacity-0"
                    }`}
                  >
                    {/* 标题 */}
                    <h1 className="text-4xl md:text-5xl lg:text-7xl font-bold text-white mb-4 leading-tight drop-shadow-xl">
                      {movie.title}
                    </h1>

                    {/* 元信息栏 */}
                    <div className="flex flex-wrap items-center gap-3 mb-6 text-sm md:text-base">
                      {movie.rate && (
                        <div className="flex items-center text-yellow-400 font-bold bg-black/30 px-2 py-1 rounded backdrop-blur-md">
                          <span className="text-lg">{movie.rate}</span>
                          <span className="text-xs ml-1">分</span>
                        </div>
                      )}

                      {heroData.genres && heroData.genres.length > 0 && (
                        <div className="flex items-center gap-2">
                          <span className="hidden md:inline text-gray-400">
                            •
                          </span>
                          {heroData.genres
                            .slice(0, 3)
                            .map((genre: string, idx: number) => (
                              <span
                                key={idx}
                                className="text-gray-200 shadow-black drop-shadow-md"
                              >
                                {genre}
                              </span>
                            ))}
                        </div>
                      )}

                      {movie.episode_info && (
                        <>
                          <span className="hidden md:inline text-gray-400">
                            •
                          </span>
                          <span className="text-gray-300 bg-white/10 px-2 py-0.5 rounded text-xs backdrop-blur-sm">
                            {movie.episode_info}
                          </span>
                        </>
                      )}
                    </div>

                    {/* 简介 - 仅PC端显示 */}
                    {heroData.description && (
                      <p
                        className="hidden md:block text-gray-300 text-base lg:text-lg mb-8 max-w-2xl leading-relaxed drop-shadow-md"
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {heroData.description}
                      </p>
                    )}

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => onMovieClick(movie)}
                        className="group flex items-center gap-3 bg-white text-black px-8 py-3.5 rounded-xl font-bold hover:bg-primary hover:scale-105 transition-all duration-300 shadow-lg shadow-white/5"
                      >
                        <Play className="w-6 h-6 fill-black group-hover:fill-black transition-colors" />
                        <span className="text-lg">立即播放</span>
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
                  ? "w-8 h-2 bg-white"
                  : "w-2 h-2 bg-white/50 hover:bg-white/75"
              } rounded-full`}
              aria-label={`跳转到第 ${index + 1} 个`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Hero Banner 骨架屏组件 - 使用与实际组件相同的宽高比
function HeroBannerSkeleton() {
  return (
    <div className="relative w-full aspect-3/4 md:aspect-12/5 overflow-hidden bg-black">
      {/* 动态渐变背景 */}
      <div className="absolute inset-0 bg-linear-to-br from-gray-900 via-gray-800 to-black">
        {/* 微光扫描效果 */}
        <div
          className="absolute inset-0 bg-linear-to-r from-transparent via-white/5 to-transparent animate-shimmer"
          style={{ backgroundSize: "200% 100%" }}
        />
      </div>

      {/* 渐变遮罩 */}
      <div className="absolute inset-0 bg-linear-to-t from-black via-black/60 to-transparent opacity-90" />
      <div className="absolute inset-0 bg-linear-to-r from-black/80 via-black/40 to-transparent hidden md:block" />

      {/* 内容骨架 */}
      <div className="absolute inset-0 flex items-end">
        <div className="w-full px-4 md:px-12 lg:px-16 pb-20 md:pb-24">
          <div className="max-w-3xl space-y-4">
            {/* 标题骨架 */}
            <div className="h-10 md:h-14 lg:h-16 bg-white/10 rounded-lg w-2/3 animate-pulse" />

            {/* 标签骨架 */}
            <div className="flex flex-wrap gap-2 md:gap-3">
              <div className="h-7 w-14 bg-white/10 rounded-full animate-pulse" />
              <div className="h-7 w-20 bg-white/10 rounded-full animate-pulse" />
              <div className="h-7 w-16 bg-white/10 rounded-full animate-pulse" />
            </div>

            {/* 描述骨架 */}
            <div className="hidden md:block space-y-2 mt-4">
              <div className="h-4 bg-white/10 rounded w-full max-w-xl animate-pulse" />
              <div className="h-4 bg-white/10 rounded w-4/5 max-w-lg animate-pulse" />
            </div>

            {/* 按钮骨架 */}
            <div className="flex gap-3 mt-6">
              <div className="h-12 w-32 bg-white/20 rounded-lg animate-pulse" />
              <div className="h-12 w-12 bg-white/10 rounded-lg animate-pulse hidden md:block" />
            </div>
          </div>
        </div>
      </div>

      {/* 指示器骨架 */}
      <div className="absolute bottom-6 md:bottom-8 left-1/2 -translate-x-1/2 flex gap-2">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className={`w-2 h-2 rounded-full animate-pulse ${
              i === 0 ? "bg-white/40 w-6" : "bg-white/20"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
