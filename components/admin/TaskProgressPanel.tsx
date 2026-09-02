"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";

/**
 * 管理后台任务实时进度面板：一句话进度 + 可选比例进度条 + 已运行时长。
 * done/total 缺失时进度条退化为不定态滑动动画。
 */
export function TaskProgressPanel({
  message,
  done,
  total,
  startedAt,
}: {
  message: string;
  done?: number;
  total?: number;
  startedAt?: string;
}) {
  // 已运行时长用独立 state 驱动重渲染，轮询间隔 3s 下足够准
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const percent =
    typeof done === "number" &&
    typeof total === "number" &&
    total > 0 &&
    done >= 0
      ? Math.min(100, Math.round((done / total) * 100))
      : null;
  const elapsedSeconds =
    startedAt && new Date(startedAt).getTime() > 0
      ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1_000))
      : null;
  const elapsedText =
    elapsedSeconds === null
      ? null
      : elapsedSeconds >= 3600
        ? `${Math.floor(elapsedSeconds / 3600)}时${Math.floor((elapsedSeconds % 3600) / 60)}分`
        : elapsedSeconds >= 60
          ? `${Math.floor(elapsedSeconds / 60)}分${elapsedSeconds % 60}秒`
          : `${elapsedSeconds}秒`;

  return (
    <div className="mb-4 border border-[#333] bg-black/30 rounded-lg px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-gray-200">
        <Loader2 size={14} className="animate-spin text-orange-400 shrink-0" />
        <span className="min-w-0 truncate" title={message}>
          {message}
        </span>
        {percent !== null && (
          <span className="ml-auto shrink-0 font-mono text-xs text-gray-400">
            {done}/{total}（{percent}%）
          </span>
        )}
        {elapsedText && (
          <span
            className={`shrink-0 font-mono text-xs text-gray-500 ${percent !== null ? "" : "ml-auto"}`}
          >
            已运行 {elapsedText}
          </span>
        )}
      </div>
      <div className="mt-2 h-1.5 bg-[#222] rounded-full overflow-hidden">
        {percent !== null ? (
          <div
            className="h-full bg-orange-500 rounded-full transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-1/3 bg-orange-500/60 rounded-full animate-[progress-slide_1.5s_ease-in-out_infinite]" />
        )}
      </div>
    </div>
  );
}
