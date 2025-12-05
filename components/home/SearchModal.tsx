import { useState } from "react";
import { useRouter } from "next/navigation";

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SearchModal({ isOpen, onClose }: SearchModalProps) {
  const router = useRouter();
  const [searchKeyword, setSearchKeyword] = useState("");

  const handleSearch = () => {
    if (!searchKeyword.trim()) return;
    onClose(); // 先关闭弹窗
    router.push(`/search?q=${encodeURIComponent(searchKeyword.trim())}`);
    setSearchKeyword(""); // 清空输入
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
                placeholder="搜索你想看的内容..."
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
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs">
                  Esc
                </kbd>{" "}
                关闭
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 点击背景关闭 */}
      <div
        className="absolute inset-0 -z-10"
        onClick={onClose}
      />
    </div>
  );
}
