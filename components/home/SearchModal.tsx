import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSearchHistory } from "@/hooks/useSearchHistory";
import { X, Clock, Trash2 } from "lucide-react";

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SearchModal({ isOpen, onClose }: SearchModalProps) {
  const router = useRouter();
  const [searchKeyword, setSearchKeyword] = useState("");
  const { history, addToHistory, removeFromHistory, clearHistory } =
    useSearchHistory();

  const handleSearch = (keyword?: string) => {
    const searchTerm = keyword || searchKeyword;
    if (!searchTerm.trim()) return;

    // 保存到搜索历史
    addToHistory(searchTerm.trim());

    onClose(); // 先关闭弹窗
    router.push(`/search?q=${encodeURIComponent(searchTerm.trim())}`);
    setSearchKeyword(""); // 清空输入
  };

  const handleHistoryClick = (keyword: string) => {
    handleSearch(keyword);
  };

  const handleRemoveHistory = (e: React.MouseEvent, keyword: string) => {
    e.stopPropagation();
    removeFromHistory(keyword);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm transition-opacity duration-200">
      <div className="flex items-start justify-center pt-32 px-4">
        <div className="w-full max-w-3xl">
          {/* 搜索框 */}
          <div className="relative">
            <div className="flex items-center bg-white rounded-lg shadow-2xl overflow-hidden">
              <div className="pl-6 pr-4 text-gray-400">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              <input
                type="text"
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                  if (e.key === "Escape") onClose();
                }}
                placeholder="搜索你想看的内容…"
                className="flex-1 px-2 py-5 text-lg text-black outline-none placeholder:text-gray-400"
                autoFocus
              />
              <button
                onClick={onClose}
                className="px-6 py-5 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* 提示文字 */}
            <div className="mt-4 text-center">
              <p className="text-sm text-gray-400">
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs">
                  Enter
                </kbd>{" "}
                开始搜索 •{" "}
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs">Esc</kbd>{" "}
                关闭
              </p>
            </div>

            {/* 搜索历史 */}
            {history.length > 0 && (
              <div className="mt-6 bg-gray-900/90 backdrop-blur-sm rounded-xl p-4 border border-white/10">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-gray-300">
                    <Clock className="w-4 h-4" />
                    <span className="text-sm font-medium">搜索历史</span>
                  </div>
                  <button
                    onClick={clearHistory}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>清除全部</span>
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {history.map((keyword, index) => (
                    <div
                      key={index}
                      onClick={() => handleHistoryClick(keyword)}
                      className="group flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-full cursor-pointer transition-all duration-200"
                    >
                      <span className="text-sm text-gray-200 group-hover:text-white">
                        {keyword}
                      </span>
                      <button
                        onClick={(e) => handleRemoveHistory(e, keyword)}
                        className="p-0.5 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all duration-200"
                        title="删除"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 点击背景关闭 */}
      <div className="absolute inset-0 -z-10" onClick={onClose} />
    </div>
  );
}
