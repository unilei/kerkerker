"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import {
  History,
  X,
  ChevronRight,
  Trash2,
  Search,
  ArrowLeft,
  Check,
  Film,
  Tv,
} from "lucide-react";

export default function HistoryPage() {
  const router = useRouter();
  const { history, isLoading, removeHistory, clearAllHistory } =
    useWatchHistory();

  // 搜索关键词
  const [searchKeyword, setSearchKeyword] = useState("");

  // 批量选择模式
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(
    new Set()
  );

  // 筛选后的历史记录
  const filteredHistory = useMemo(() => {
    if (!searchKeyword.trim()) return history;
    const keyword = searchKeyword.toLowerCase();
    return history.filter((item) => item.name.toLowerCase().includes(keyword));
  }, [history, searchKeyword]);

  // 切换选择
  const toggleSelect = (id: string | number) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredHistory.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredHistory.map((item) => item.id)));
    }
  };

  // 批量删除
  const deleteSelected = () => {
    selectedIds.forEach((id) => removeHistory(id));
    setSelectedIds(new Set());
    setIsSelectMode(false);
  };

  // 播放视频
  const handlePlay = (item: (typeof history)[0]) => {
    if (isSelectMode) {
      toggleSelect(item.id);
      return;
    }
    const url = item.sourceKey
      ? `/play/${item.id}?source=${item.sourceKey}&from=history`
      : `/play/${item.id}?from=history`;
    router.push(url);
  };

  // 格式化时间
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return "今天";
    if (days === 1) return "昨天";
    if (days < 7) return `${days}天前`;
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };

  return (
    <div className="min-h-screen bg-black">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-50 bg-black/95 backdrop-blur-sm border-b border-white/10">
        <div className="px-4 md:px-12 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.back()}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
              aria-label="返回"
            >
              <ArrowLeft className="w-5 h-5 text-white" />
            </button>
            <h1 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
              <History className="w-6 h-6 text-red-500" />
              <span>观看历史</span>
              {history.length > 0 && (
                <span className="text-sm font-normal text-gray-400">
                  ({history.length})
                </span>
              )}
            </h1>
          </div>

          {/* 操作按钮 */}
          {history.length > 0 && (
            <div className="flex items-center gap-2">
              {isSelectMode ? (
                <>
                  <button
                    onClick={toggleSelectAll}
                    className="px-3 py-1.5 text-sm text-gray-300 hover:text-white transition-colors"
                  >
                    {selectedIds.size === filteredHistory.length
                      ? "取消全选"
                      : "全选"}
                  </button>
                  <button
                    onClick={deleteSelected}
                    disabled={selectedIds.size === 0}
                    className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-1"
                  >
                    <Trash2 className="w-4 h-4" />
                    删除 ({selectedIds.size})
                  </button>
                  <button
                    onClick={() => {
                      setIsSelectMode(false);
                      setSelectedIds(new Set());
                    }}
                    className="px-3 py-1.5 text-sm text-gray-300 hover:text-white transition-colors"
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setIsSelectMode(true)}
                    className="px-3 py-1.5 text-sm text-gray-300 hover:text-white transition-colors"
                  >
                    选择
                  </button>
                  <button
                    onClick={clearAllHistory}
                    className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
                  >
                    <Trash2 className="w-4 h-4" />
                    清空
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* 搜索栏 */}
        {history.length > 0 && (
          <div className="px-4 md:px-12 pb-4">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                placeholder="搜索历史记录…"
                className="w-full pl-10 pr-4 py-2.5 bg-white/10 border border-white/10 rounded-lg text-white placeholder:text-gray-500 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/50 transition-colors"
              />
              {searchKeyword && (
                <button
                  onClick={() => setSearchKeyword("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-white/10 rounded-full transition-colors"
                >
                  <X className="w-4 h-4 text-gray-400" />
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      {/* 内容区域 */}
      <main className="px-4 md:px-12 py-6">
        {isLoading ? (
          /* 加载状态 */
          <div className="flex flex-col items-center justify-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-700 border-t-red-600 mb-4" />
            <p className="text-gray-400">加载中…</p>
          </div>
        ) : history.length === 0 ? (
          /* 空状态 */
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-24 h-24 bg-gray-800 rounded-full flex items-center justify-center mb-6">
              <History className="w-12 h-12 text-gray-600" />
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">
              暂无观看历史
            </h2>
            <p className="text-gray-400 mb-6">开始观看视频后，历史记录将显示在这里</p>
            <Link
              href="/"
              className="px-6 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
            >
              去首页看看
            </Link>
          </div>
        ) : filteredHistory.length === 0 ? (
          /* 搜索无结果 */
          <div className="flex flex-col items-center justify-center py-20">
            <Search className="w-12 h-12 text-gray-600 mb-4" />
            <h2 className="text-xl font-semibold text-white mb-2">
              未找到相关记录
            </h2>
            <p className="text-gray-400">
              没有找到包含 "{searchKeyword}" 的历史记录
            </p>
          </div>
        ) : (
          /* 历史列表 */
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
            {filteredHistory.map((item) => (
              <div
                key={item.id}
                onClick={() => handlePlay(item)}
                className={`cursor-pointer group/card relative ${
                  isSelectMode && selectedIds.has(item.id)
                    ? "ring-2 ring-red-500 rounded-lg"
                    : ""
                }`}
              >
                <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-gray-800 shadow-lg transition-all duration-300 group-hover/card:shadow-xl group-hover/card:shadow-red-500/20 group-hover/card:scale-105">
                  {/* 封面图 */}
                  {item.cover && (
                    <img
                      src={item.cover}
                      alt={item.name}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.classList.add("hidden");
                      }}
                    />
                  )}
                  {/* Fallback 占位 */}
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-900 -z-10">
                    <span className="text-gray-400 text-sm text-center px-2">
                      {item.name}
                    </span>
                  </div>

                  {/* 渐变遮罩 */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

                  {/* 选择模式的勾选框 */}
                  {isSelectMode && (
                    <div
                      className={`absolute top-2 left-2 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
                        selectedIds.has(item.id)
                          ? "bg-red-600 border-red-600"
                          : "border-white/50 bg-black/30"
                      }`}
                    >
                      {selectedIds.has(item.id) && (
                        <Check className="w-4 h-4 text-white" />
                      )}
                    </div>
                  )}

                  {/* 播放源标签 */}
                  {!isSelectMode && item.sourceName && (
                    <div className="absolute top-2 left-2 z-10">
                      <span className="bg-black/60 backdrop-blur-md border border-white/10 text-white text-[10px] px-2 py-0.5 rounded-md shadow-xl">
                        {item.sourceName}
                      </span>
                    </div>
                  )}

                  {/* 观看时间标签 */}
                  <div className="absolute top-2 right-2 z-10">
                    <span className="bg-black/60 backdrop-blur-md text-gray-300 text-[10px] px-2 py-0.5 rounded-md">
                      {formatTime(item.timestamp)}
                    </span>
                  </div>

                  {/* 播放进度指示 */}
                  <div className="absolute bottom-0 left-0 right-0 p-3">
                    <p className="text-white text-sm font-medium line-clamp-1 mb-1">
                      {item.name}
                    </p>
                    <p className="text-gray-300 text-xs">
                      看到第 {item.episode + 1} 集
                    </p>
                  </div>

                  {/* 删除按钮 - 非选择模式 */}
                  {!isSelectMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeHistory(item.id);
                      }}
                      className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-red-600 rounded-full opacity-0 group-hover/card:opacity-100 transition-all duration-200 z-20"
                      aria-label="移除历史记录"
                    >
                      <X className="w-3.5 h-3.5 text-white" />
                    </button>
                  )}

                  {/* 继续播放按钮 - 非选择模式 */}
                  {!isSelectMode && (
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/card:opacity-100 transition-opacity duration-200">
                      <div className="w-14 h-14 rounded-full bg-red-600/90 flex items-center justify-center shadow-lg shadow-red-500/50">
                        <ChevronRight className="w-8 h-8 text-white ml-1" />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
