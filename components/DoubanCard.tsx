'use client';

import { useState } from 'react';
import { Play, Star } from 'lucide-react';
import { DoubanMovie } from '@/types/douban';

interface DoubanCardProps {
  movie: DoubanMovie;
  onSelect: (movie: DoubanMovie) => void;
  /** 是否为首屏可见卡片，优先加载 */
  priority?: boolean;
}

export default function DoubanCard({ movie, onSelect, priority = false }: DoubanCardProps) {
  const [imageError, setImageError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
 
  // 豆瓣图片使用代理
  const imageUrl = `/api/image-proxy?url=${encodeURIComponent(movie.cover)}`;

  return (
    <div
      onClick={() => onSelect(movie)}
      className="group relative cursor-pointer transition-all duration-300 hover:scale-102 hover:z-10"
    >
      {/* 海报图片 */}
      <div className="relative aspect-2/3 overflow-hidden rounded-lg bg-gray-800">
        {!imageError ? (
          <img
            src={imageUrl}
            alt={movie.title}
            // 非首屏图片使用懒加载，不阻塞 hydration
            loading={priority ? "eager" : "lazy"}
            // 首屏图片优先加载
            fetchPriority={priority ? "high" : "auto"}
            // 提供尺寸提示，避免布局偏移
            decoding="async"
            className={`w-full h-full object-cover transition-opacity duration-300 ${
              isLoading ? 'opacity-0' : 'opacity-100'
            }`}
            onLoad={() => setIsLoading(false)}
            onError={() => {
              setImageError(true);
              setIsLoading(false);
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}
        
        {/* 加载状态 */}
        {isLoading && !imageError && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-600 border-t-white" />
          </div>
        )}

        {/* 评分标签 */}
        {movie.rate  && (
          <div className="absolute top-2 left-2 px-2 py-1 bg-black/80 backdrop-blur-sm rounded text-yellow-400 text-sm font-bold flex items-center space-x-1">
            <Star className="w-4 h-4 fill-current" />
            <span>{movie.rate}</span>
          </div>
        )}
 
      </div>

      {/* 悬浮信息层 */}
      <div className="absolute inset-0 bg-linear-to-t from-black via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-lg flex flex-col justify-end p-4">
        <h3 className="text-white font-bold text-base mb-2 line-clamp-2">
          {movie.title}
        </h3>
        
        {movie.episode_info && movie.episode_info.length > 0 && (
          <p className="text-gray-300 text-xs mb-2">
            {movie.episode_info}
          </p>
        )}

        {/* 播放按钮 */}
        <div className="mt-3 flex items-center space-x-2">
          <button className="flex items-center gap-2 bg-white text-black px-4 py-2 rounded-lg text-sm font-semibold hover:bg-opacity-90 hover:scale-105 transition-all duration-200 shadow-lg">
            <Play className="w-4 h-4 fill-current" />
            <span>立即播放</span>
          </button>
        </div>
      </div>
    </div>
  );
}
