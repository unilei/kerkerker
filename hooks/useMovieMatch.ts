import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DoubanMovie } from "@/types/douban";

interface ToastState {
  message: string;
  type: "success" | "error" | "warning" | "info";
}

interface UseMovieMatchReturn {
  matchingMovie: string | null;
  handleMovieClick: (movie: DoubanMovie) => Promise<void>;
  toast: ToastState | null;
  setToast: (toast: ToastState | null) => void;
}

/**
 * 处理影片匹配和播放逻辑
 */
export function useMovieMatch(): UseMovieMatchReturn {
  const router = useRouter();
  const [matchingMovie, setMatchingMovie] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const handleMovieClick = async (movie: DoubanMovie) => {
    setMatchingMovie(movie.id);
    
    try {
      const response = await fetch("/api/douban/match-vod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          douban_id: movie.id,
          title: movie.title,
        }),
      });

      const result = await response.json();

      if (
        result.code === 200 &&
        result.data?.matches &&
        result.data.matches.length > 0
      ) {
        const matches = result.data.matches;

        localStorage.setItem(
          "multi_source_matches",
          JSON.stringify({
            douban_id: movie.id,
            title: movie.title,
            matches: matches,
            timestamp: Date.now(),
          })
        );

        const firstMatch = matches[0];
        router.push(
          `/play/${firstMatch.vod_id}?source=${firstMatch.source_key}&multi=true`
        );
      } else {
        setToast({
          message: `未在任何播放源中找到《${movie.title}》\n\n已搜索 ${
            result.data?.total_sources || 0
          } 个视频源`,
          type: "warning",
        });
      }
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : "搜索播放源时出错，请重试",
        type: "error",
      });
    } finally {
      setMatchingMovie(null);
    }
  };

  return {
    matchingMovie,
    handleMovieClick,
    toast,
    setToast,
  };
}
