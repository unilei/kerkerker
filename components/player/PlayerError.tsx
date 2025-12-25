/**
 * 播放器错误状态组件
 */

import type { PlayerError } from "@/lib/player/types";

interface PlayerErrorProps {
  error: PlayerError;
  retryCount: number;
  onRetry: () => void;
  onReload: () => void;
}

const ERROR_TITLES: Record<PlayerError["type"], string> = {
  network: "网络错误",
  media: "媒体错误",
  key: "加密密钥错误",
  manifest: "清单加载失败",
  fragment: "视频片段错误",
  unknown: "播放失败",
};

export function PlayerErrorDisplay({
  error,
  retryCount,
  onRetry,
  onReload,
}: PlayerErrorProps) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/95 z-50">
      <div className="text-center px-6 max-w-md">
        <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-10 h-10 text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>

        <h3 className="text-white text-xl font-semibold mb-2">
          {ERROR_TITLES[error.type]}
        </h3>

        <p className="text-gray-300 text-base mb-6">{error.message}</p>

        <div className="flex gap-3 justify-center">
          {error.canRetry && (
            <button
              onClick={onRetry}
              className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors font-medium"
            >
              重新加载
            </button>
          )}
          <button
            onClick={onReload}
            className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors font-medium"
          >
            刷新页面
          </button>
        </div>

        {retryCount > 0 && (
          <p className="text-gray-500 text-sm mt-4">已重试 {retryCount} 次</p>
        )}
      </div>
    </div>
  );
}
