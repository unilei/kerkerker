'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, ChevronLeft, ChevronRight, Globe, Info, Star } from 'lucide-react';
import { getCalendar, type CalendarDay, type CalendarEntry, type CalendarResponse } from '@/lib/douban-service';
import { Toast } from '@/components/Toast';
import { getImageUrl } from '@/lib/utils/image-utils';

// Hooks
import { useScrollState } from '@/hooks/useScrollState';
import { useMovieMatch } from '@/hooks/useMovieMatch';

// Components
import { Navbar } from '@/components/home/Navbar';
import { SearchModal } from '@/components/home/SearchModal';
import { Footer } from '@/components/home/Footer';

const REGIONS = [
  { code: 'CN', label: '中国', emoji: '🇨🇳' },
  { code: 'US', label: '美国', emoji: '🇺🇸' },
  { code: 'JP', label: '日本', emoji: '🇯🇵' },
  { code: 'KR', label: '韩国', emoji: '🇰🇷' },
  { code: 'GB', label: '英国', emoji: '🇬🇧' },
];

function formatDate(dateStr: string): { main: string; sub: string; isToday: boolean; isTomorrow: boolean } {
  const date = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  
  const todayStr = today.toISOString().split('T')[0];
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const mainText = `${date.getMonth() + 1}月${date.getDate()}日`;
  const subText = weekDays[date.getDay()];
  
  return {
    main: mainText,
    sub: subText,
    isToday: dateStr === todayStr,
    isTomorrow: dateStr === tomorrowStr,
  };
}

// 日历条目卡片组件
function CalendarCard({ 
  entry, 
  onClick,
  priority = false 
}: { 
  entry: CalendarEntry; 
  onClick: () => void;
  priority?: boolean;
}) {
  const [imageError, setImageError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // 使用统一的图片处理工具
  const imageUrl = getImageUrl(entry.poster || '');

  const displayName = entry.show_name_cn || entry.show_name;
  const episodeInfo = entry.season_number > 0 
    ? `S${entry.season_number}E${entry.episode_number}` 
    : `第${entry.episode_number}集`;

  return (
    <div
      onClick={onClick}
      className="group relative cursor-pointer transition-all duration-300 hover:scale-102 hover:z-10"
    >
      {/* 海报图片 */}
      <div className="relative aspect-2/3 overflow-hidden rounded-lg bg-gray-800">
        {!imageError ? (
          <img
            src={imageUrl}
            alt={displayName}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
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
          <div className="w-full h-full flex items-center justify-center text-gray-500 bg-gradient-to-br from-gray-700 to-gray-800">
            <Calendar className="w-12 h-12" />
          </div>
        )}

        {/* 加载骨架 - 使用渐变动画 */}
        {isLoading && !imageError && (
          <div className="absolute inset-0 bg-gradient-to-br from-gray-700 to-gray-800">
            <div 
              className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer"
              style={{ backgroundSize: '200% 100%' }}
            />
          </div>
        )}

        {/* 评分标签 */}
        {entry.vote_average > 0 && (
          <div className="absolute top-2 left-2 px-2 py-1 bg-black/80 backdrop-blur-sm rounded text-yellow-400 text-sm font-bold flex items-center space-x-1">
            <Star className="w-3 h-3 fill-current" />
            <span>{entry.vote_average.toFixed(1)}</span>
          </div>
        )}

        {/* 集数标签 */}
        <div className="absolute top-2 right-2 px-2 py-1 bg-red-600/90 backdrop-blur-sm rounded text-white text-xs font-medium">
          {episodeInfo}
        </div>

        {/* 悬浮层 */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-lg flex flex-col justify-end p-3">
          <h3 className="text-white font-bold text-sm mb-1 line-clamp-2">
            {displayName}
          </h3>
          <p className="text-gray-300 text-xs mb-2">
            {episodeInfo} · {entry.episode_name || '最新集'}
          </p>
          <button className="flex items-center justify-center gap-2 bg-white text-black px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-opacity-90 transition-all">
            <Info className="w-3 h-3" />
            <span>查看详情</span>
          </button>
        </div>
      </div>

      {/* 标题 */}
      <div className="mt-2">
        <h3 className="text-white font-medium text-sm line-clamp-2 group-hover:text-red-500 transition-colors">
          {displayName}
        </h3>
        {entry.episode_name && entry.episode_name !== displayName && (
          <p className="text-gray-400 text-xs mt-1 line-clamp-1">
            {entry.episode_name}
          </p>
        )}
      </div>
    </div>
  );
}

// 日期分组组件
function CalendarDaySection({ 
  day, 
  onEntryClick 
}: { 
  day: CalendarDay; 
  onEntryClick: (entry: CalendarEntry) => void;
}) {
  const dateInfo = formatDate(day.date);
  
  if (!day.entries || day.entries.length === 0) return null;

  return (
    <div className="px-4 md:px-12">
      {/* 日期标题 */}
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-2 h-2 rounded-full ${dateInfo.isToday ? 'bg-red-500' : dateInfo.isTomorrow ? 'bg-yellow-500' : 'bg-gray-500'}`} />
        <h2 className="text-xl md:text-2xl font-bold text-white flex items-center gap-2">
          {dateInfo.isToday && <span className="text-red-500">今天</span>}
          {dateInfo.isTomorrow && <span className="text-yellow-500">明天</span>}
          <span>{dateInfo.main}</span>
          <span className="text-gray-400 text-base font-normal">{dateInfo.sub}</span>
        </h2>
        <span className="text-gray-500 text-sm">
          {day.entries.length} 部剧集
        </span>
      </div>

      {/* 剧集网格 - 横向滚动 */}
      <div className="relative group">
        <div className="flex overflow-x-auto space-x-3 md:space-x-4 pb-4 scrollbar-hide scroll-smooth">
          {day.entries.map((entry, index) => (
            <div key={`${entry.show_id}-${entry.episode_number}-${index}`} className="shrink-0 w-36 sm:w-44 md:w-52">
              <CalendarCard
                entry={entry}
                onClick={() => onEntryClick(entry)}
                priority={index < 5}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 加载骨架屏
function CalendarSkeleton() {
  return (
    <div className="space-y-10 pt-8 pb-16">
      {[...Array(3)].map((_, dayIndex) => (
        <div key={dayIndex} className="px-4 md:px-12">
          {/* 日期标题骨架 */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-2 h-2 rounded-full bg-gray-700" />
            <div className="h-7 w-32 bg-gray-800 rounded relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer" style={{ backgroundSize: '200% 100%' }} />
            </div>
            <div className="h-5 w-16 bg-gray-800 rounded" />
          </div>
          
          {/* 卡片骨架 */}
          <div className="flex space-x-3 md:space-x-4 overflow-hidden">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="shrink-0 w-36 sm:w-44 md:w-52">
                <div className="aspect-2/3 bg-gray-800 rounded-lg relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer" style={{ backgroundSize: '200% 100%' }} />
                </div>
                <div className="mt-2 h-4 bg-gray-800 rounded w-3/4" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CalendarPage() {
  const router = useRouter();
  const [showSearch, setShowSearch] = useState(false);
  const scrolled = useScrollState(50);
  const { handleMovieClick, toast, setToast } = useMovieMatch();

  const [calendarData, setCalendarData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState('CN');
  const [weekOffset, setWeekOffset] = useState(0);

  // 计算日期范围
  const dateRange = useMemo(() => {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() + weekOffset * 7);
    
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);

    return {
      start: startDate.toISOString().split('T')[0],
      end: endDate.toISOString().split('T')[0],
    };
  }, [weekOffset]);

  // 加载日历数据
  useEffect(() => {
    async function fetchCalendar() {
      setLoading(true);
      setError(null);
      try {
        const data = await getCalendar({
          start_date: dateRange.start,
          end_date: dateRange.end,
          region,
        });
        setCalendarData(data);
      } catch (err) {
        console.error('Failed to fetch calendar:', err);
        setError('获取日历数据失败，请稍后重试');
      } finally {
        setLoading(false);
      }
    }

    fetchCalendar();
  }, [dateRange, region]);

  // 过滤有内容的日期
  const daysWithContent = useMemo(() => {
    if (!calendarData?.days) return [];
    return calendarData.days.filter(day => day.entries && day.entries.length > 0);
  }, [calendarData]);

  // 处理剧集点击
  const handleEntryClick = (entry: CalendarEntry) => {
    if (entry.douban_id) {
      router.push(`/movie/${entry.douban_id}`);
    } else {
      router.push(`/search?q=${encodeURIComponent(entry.show_name_cn || entry.show_name)}`);
    }
  };

  const currentRegion = REGIONS.find(r => r.code === region);

  return (
    <div className="min-h-screen bg-black">
      {/* 导航栏 */}
      <Navbar scrolled={scrolled} onSearchOpen={() => setShowSearch(true)} />

      {/* 搜索弹窗 */}
      <SearchModal isOpen={showSearch} onClose={() => setShowSearch(false)} />

      {/* Hero 区域 */}
      <div className="relative w-full pt-16 pb-8 md:pt-20 md:pb-12 bg-gradient-to-b from-gray-900 to-black">
        <div className="px-4 md:px-12 lg:px-16">
          {/* 标题行 */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white flex items-center gap-3">
                <Calendar className="w-8 h-8 md:w-10 md:h-10 text-red-500" />
                追剧日历
              </h1>
              <p className="text-gray-400 mt-2 text-sm md:text-base">
                {dateRange.start.replace(/-/g, '/')} - {dateRange.end.replace(/-/g, '/')}
              </p>
            </div>

            {/* 控制区 */}
            <div className="flex items-center gap-3">
              {/* 地区选择 */}
              <div className="relative">
                <select
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  className="appearance-none bg-white/10 text-white px-4 py-2.5 pr-10 rounded-xl text-sm cursor-pointer hover:bg-white/20 transition-colors backdrop-blur-sm border border-white/10"
                >
                  {REGIONS.map((r) => (
                    <option key={r.code} value={r.code} className="bg-gray-900 text-white">
                      {r.emoji} {r.label}
                    </option>
                  ))}
                </select>
                <Globe className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              </div>

              {/* 周切换 */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setWeekOffset((prev) => prev - 1)}
                  disabled={weekOffset <= -2}
                  className="p-2.5 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors border border-white/10"
                >
                  <ChevronLeft className="w-5 h-5 text-white" />
                </button>
                <button
                  onClick={() => setWeekOffset(0)}
                  className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    weekOffset === 0
                      ? 'bg-red-600 text-white'
                      : 'bg-white/10 text-gray-300 hover:bg-white/20 border border-white/10'
                  }`}
                >
                  本周
                </button>
                <button
                  onClick={() => setWeekOffset((prev) => prev + 1)}
                  disabled={weekOffset >= 2}
                  className="p-2.5 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors border border-white/10"
                >
                  <ChevronRight className="w-5 h-5 text-white" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 内容区 */}
      {loading ? (
        <CalendarSkeleton />
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-32">
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => setWeekOffset(0)}
            className="px-6 py-2.5 bg-red-600 rounded-xl hover:bg-red-700 transition-colors text-white font-medium"
          >
            重试
          </button>
        </div>
      ) : daysWithContent.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32">
          <Calendar className="w-20 h-20 text-gray-700 mb-4" />
          <p className="text-gray-400 text-xl font-medium">本周暂无剧集播出</p>
          <p className="text-gray-500 text-sm mt-2">试试切换其他地区或时间范围</p>
        </div>
      ) : (
        <div className="relative z-20 space-y-10 md:space-y-12 lg:space-y-16 pb-16 pt-8">
          {daysWithContent.map((day) => (
            <CalendarDaySection
              key={day.date}
              day={day}
              onEntryClick={handleEntryClick}
            />
          ))}
        </div>
      )}

      {/* 匹配中遮罩 */}
      {/* Toast 通知 */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* Footer */}
      <Footer />
    </div>
  );
}
