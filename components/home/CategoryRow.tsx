import type { ReactElement } from "react";
import type { DoubanMovie } from "@/types/douban";
import DoubanCard from "@/components/DoubanCard";

interface CategoryRowProps {
  title: string;
  icon: ReactElement;
  movies: DoubanMovie[];
  onMovieClick: (movie: DoubanMovie) => void;
  onViewMore: () => void;
}

export function CategoryRow({
  title,
  icon,
  movies,
  onMovieClick,
  onViewMore,
}: CategoryRowProps) {
  const INITIAL_DISPLAY_COUNT = 15;
  const displayMovies = movies.slice(0, INITIAL_DISPLAY_COUNT);
  const hasMore = movies.length > INITIAL_DISPLAY_COUNT;

  return (
    <div className="px-4 md:px-12">
      {/* 标题和查看更多 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
          {icon}
          <span>{title}</span>
        </h2>
        {hasMore && (
          <button
            onClick={onViewMore}
            className="text-sm text-gray-400 hover:text-white transition-colors flex items-center space-x-1 group"
          >
            <span>查看全部</span>
            <svg
              className="w-4 h-4 group-hover:translate-x-1 transition-transform"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        )}
      </div>

      {/* 横向滚动列表 */}
      <div className="relative group">
        <div className="flex overflow-x-auto space-x-3 md:space-x-4 pb-4 scrollbar-hide scroll-smooth">
          {displayMovies.map((movie) => (
            <div key={movie.id} className="shrink-0 w-40 sm:w-48 md:w-56">
              <DoubanCard movie={movie} onSelect={onMovieClick} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
