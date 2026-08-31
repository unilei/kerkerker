"use client";

import { useState, useCallback } from "react";
import { Search, X } from "lucide-react";

interface SearchModalProps {
  onClose: () => void;
  onSearch: (keyword: string) => void;
}

export function SearchModal({ onClose, onSearch }: SearchModalProps) {
  const [keyword, setKeyword] = useState("");

  const submit = useCallback(() => {
    const trimmed = keyword.trim();
    if (trimmed) onSearch(trimmed);
  }, [keyword, onSearch]);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/80 backdrop-blur-sm pt-24 px-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-[#141414] border border-white/10 rounded-2xl p-4 shadow-2xl">
        <div className="flex items-center gap-3">
          <Search className="w-5 h-5 text-gray-400 shrink-0" />
          <input
            autoFocus
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") onClose();
            }}
            placeholder="搜索短剧名称…"
            className="flex-1 bg-transparent text-white text-base outline-none placeholder:text-gray-600"
          />
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-white/10 rounded-full transition-colors"
            aria-label="关闭"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>
      </div>
    </div>
  );
}
