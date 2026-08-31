'use client';

import Link from 'next/link';

export interface ShortDramaCardData {
  id: string;
  title: string;
  episode_count?: number;
  cover_url?: string;
  tags?: string[];
}

interface ShortDramaCardProps {
  drama: ShortDramaCardData;
  /** 是否为首屏可见卡片，优先加载 */
  priority?: boolean;
}

export default function ShortDramaCard({ drama, priority = false }: ShortDramaCardProps) {
  return (
    <Link
      href={`/drama/${drama.id}`}
      className="group relative block cursor-pointer transition-all duration-300 hover:scale-102 hover:z-10"
    >
      {/* 海报图片 */}
      <div className="relative aspect-2/3 overflow-hidden rounded-lg bg-gray-800">
        {drama.cover_url ? (
          <img
            src={drama.cover_url}
            alt={drama.title}
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            decoding="async"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}

        {/* 集数标签 */}
        {drama.episode_count ? (
          <div className="absolute top-2 left-2 px-2 py-1 bg-black/80 backdrop-blur-sm rounded text-orange-400 text-sm font-bold">
            {drama.episode_count}集
          </div>
        ) : null}
      </div>

      {/* 悬浮信息层 */}
      <div className="absolute inset-0 bg-linear-to-t from-black via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-lg flex flex-col justify-end p-4">
        <h3 className="text-white font-bold text-base mb-2 line-clamp-2">
          {drama.title}
        </h3>
        {drama.tags && drama.tags.length > 0 && (
          <p className="text-gray-300 text-xs mb-2 line-clamp-1">
            {drama.tags.slice(0, 4).join(' · ')}
          </p>
        )}
        <div className="mt-3 flex items-center space-x-2">
          <button className="flex items-center gap-2 bg-white text-black px-4 py-2 rounded-lg text-sm font-semibold hover:bg-opacity-90 hover:scale-105 transition-all duration-200 shadow-lg">
            <span>查看详情</span>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* 底部常显剧名 */}
      <h3 className="mt-2 text-sm text-white font-medium line-clamp-1 group-hover:text-red-400 transition-colors">
        {drama.title}
      </h3>
    </Link>
  );
}
