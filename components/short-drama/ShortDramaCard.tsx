"use client";

import { useState } from 'react';
import Link from 'next/link';

export interface ShortDramaCardData {
  id: string;
  title: string;
  episode_count?: number;
  cover_url?: string;
  tags?: string[];
  publish_date?: string;
}

interface ShortDramaCardProps {
  drama: ShortDramaCardData;
  /** 是否为首屏可见卡片，优先加载 */
  priority?: boolean;
}

/** MM-DD（跨年带年份），解析失败返回空串 */
function formatPublishDate(value?: string): string {
  if (!value) return "";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value.slice(0, 10);
  const [, year, month, day] = match;
  const currentYear = new Date().getFullYear().toString();
  return year === currentYear ? `${month}-${day}` : `${year}-${month}-${day}`;
}

export default function ShortDramaCard({ drama, priority = false }: ShortDramaCardProps) {
  // 封面挂掉时退回占位图，避免破图外露
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = Boolean(drama.cover_url) && !coverFailed;
  const dateLabel = formatPublishDate(drama.publish_date);

  return (
    <Link
      href={`/drama/${drama.id}`}
      className="group relative block cursor-pointer transition-all duration-300 hover:scale-102 hover:z-10"
    >
      {/* 海报图片 */}
      <div className="relative aspect-2/3 overflow-hidden rounded-lg bg-gray-800">
        {showCover ? (
          <img
            src={drama.cover_url}
            alt={drama.title}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            onError={() => setCoverFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}

        {/* 悬浮信息层（桌面端 hover 展开；整卡即链接，纯视觉装饰。
            只放标签不放标题——标题下方常显，悬浮再放会重复；
            窄卡不下 CTA 按钮——lg 档卡片仅约百像素宽，按钮放不下 */}
        <div className="absolute inset-0 bg-linear-to-t from-black via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-lg flex-col justify-end p-3 hidden md:flex">
          {drama.tags && drama.tags.length > 0 && (
            <p className="text-gray-300 text-xs line-clamp-1">
              {drama.tags.slice(0, 4).join(' · ')}
            </p>
          )}
        </div>
      </div>

      {/* 底部常显剧名 + 集数/日期（原海报角标挪到这里，一行并列） */}
      <h3 className="mt-2 text-sm text-white font-medium line-clamp-1 group-hover:text-red-400 transition-colors">
        {drama.title}
      </h3>
      {drama.episode_count || dateLabel ? (
        <p className="mt-0.5 truncate text-xs text-gray-500">
          {drama.episode_count ? <span className="text-orange-400/90">{drama.episode_count}集</span> : null}
          {drama.episode_count && dateLabel ? <span className="mx-1">·</span> : null}
          {dateLabel ? <span>{dateLabel} 上新</span> : null}
        </p>
      ) : null}
    </Link>
  );
}
