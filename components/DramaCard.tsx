'use client';

import { useState } from 'react';
import { Play } from 'lucide-react';
import { Drama } from '@/types/drama';

interface DramaCardProps {
  drama: Drama;
  onSelect: (drama: Drama) => void;
}

export default function DramaCard({ drama, onSelect }: DramaCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  const getProxyImageUrl = (url: string) => {
    if (!url) return '';
    return `//wsrv.nl/?url=${encodeURIComponent(url)}&w=400&h=600&fit=cover&output=webp`;
  };

  return (
    <div
      className="relative cursor-pointer transition-all duration-300 ease-out group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onSelect(drama)}
    >
      {/* 卡片容器 */}
      <div className={`relative rounded overflow-hidden transition-all duration-300 ${
        isHovered ? 'scale-102 z-10 shadow-2xl' : 'scale-100'
      }`}>
        {/* 图片 */}
        <div className="relative aspect-[2/3] bg-gray-900">
          {drama.pic ? (
            <>
              <img
                src={getProxyImageUrl(drama.pic)}
                alt={drama.name}
                className={`w-full h-full object-cover transition-opacity duration-300 ${
                  imageLoaded ? 'opacity-100' : 'opacity-0'
                }`}
                onLoad={() => setImageLoaded(true)}
                loading="lazy"
              />
              {!imageLoaded && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-8 h-8 border-2 border-gray-700 border-t-gray-500 rounded-full animate-spin" />
                </div>
              )}
            </>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-gray-600">
              <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          )}

          {/* 渐变遮罩 */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        </div>

        {/* 悬停信息 */}
        <div className={`absolute bottom-0 left-0 right-0 p-3 transform transition-all duration-300 ${
          isHovered ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'
        }`}>
          <h3 className="text-white font-semibold text-sm mb-1 line-clamp-2">{drama.name}</h3>
          
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2 text-xs">
              {drama.remarks && (
                <span className="px-2 py-0.5 bg-green-600 text-white rounded text-xs font-medium">
                  {drama.remarks}
                </span>
              )}
              {drama.year && (
                <span className="text-gray-300">{drama.year}</span>
              )}
            </div>
          </div>

          {drama.type && (
            <p className="text-gray-400 text-xs line-clamp-1">{drama.type}</p>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center space-x-2 mt-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSelect(drama);
              }}
              className="flex-1 flex items-center justify-center gap-2 bg-white text-black px-4 py-2 rounded-lg text-sm font-semibold hover:bg-opacity-90 hover:scale-105 transition-all duration-200 shadow-lg"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>立即播放</span>
            </button>
            
            <button
              onClick={(e) => {
                e.stopPropagation();
              }}
              className="p-2 bg-gray-800/80 text-white rounded-full hover:bg-gray-700/80 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        </div>

        {/* 标签 */}
        {!isHovered && drama.remarks && (
          <div className="absolute top-2 right-2 px-2 py-1 bg-green-600/90 backdrop-blur-sm text-white rounded text-xs font-medium">
            {drama.remarks}
          </div>
        )}
      </div>
    </div>
  );
}
