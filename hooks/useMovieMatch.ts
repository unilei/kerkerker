import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DoubanMovie } from "@/types/douban";

interface ToastState {
  message: string;
  type: "success" | "error" | "warning" | "info";
}

interface UseMovieMatchReturn {
  matchingMovie: string | null;
  handleMovieClick: (movie: DoubanMovie) => void;
  toast: ToastState | null;
  setToast: (toast: ToastState | null) => void;
}

// 缓存键
const MOVIE_CACHE_KEY = 'movie_detail_cache';

// 电影数据缓存结构
export interface MovieCacheData {
  id: string;
  title: string;
  cover: string;
  rate: string;
  episode_info: string;
  timestamp: number;
}

// 保存电影数据到缓存
export function saveMovieCache(movie: DoubanMovie): void {
  try {
    const data: MovieCacheData = {
      id: movie.id,
      title: movie.title,
      cover: movie.cover,
      rate: movie.rate || '',
      episode_info: movie.episode_info || '',
      timestamp: Date.now(),
    };
    sessionStorage.setItem(MOVIE_CACHE_KEY, JSON.stringify(data));
  } catch {
    // 存储失败，静默处理
  }
}

// 读取电影数据缓存
export function loadMovieCache(movieId: string): MovieCacheData | null {
  try {
    const cached = sessionStorage.getItem(MOVIE_CACHE_KEY);
    if (!cached) return null;
    
    const data: MovieCacheData = JSON.parse(cached);
    
    // 检查 ID 是否匹配
    if (data.id !== movieId) return null;
    
    // 检查是否过期（1 小时）
    if (Date.now() - data.timestamp > 60 * 60 * 1000) {
      sessionStorage.removeItem(MOVIE_CACHE_KEY);
      return null;
    }
    
    return data;
  } catch {
    return null;
  }
}

/**
 * 处理影片点击 - 立即跳转到详情页
 * 搜索逻辑已移至详情页内部处理
 */
export function useMovieMatch(): UseMovieMatchReturn {
  const router = useRouter();
  const [matchingMovie] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const handleMovieClick = (movie: DoubanMovie) => {
    // 缓存电影数据到 sessionStorage
    saveMovieCache(movie);
    
    // 只传 ID，URL 简洁干净
    router.push(`/movie/${movie.id}`);
  };

  return {
    matchingMovie,
    handleMovieClick,
    toast,
    setToast,
  };
}
