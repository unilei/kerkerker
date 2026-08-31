"use client";

import { useState } from "react";
import { Link2, Copy, Check, ExternalLink, FileText } from "lucide-react";
import { BrandBadge } from "@/components/short-drama/BrandBadge";

interface ShortDramaPanProps {
  shareUrl: string;
  shareCode?: string;
  episodeCount?: number;
}

/**
 * 短剧网盘资源区块（复刻影片详情页 PanResourceSection 的资源行样式）
 * 展示自己转存后的夸克分享链接；提取码一键复制。
 */
export function ShortDramaPanSection({ shareUrl, shareCode, episodeCount }: ShortDramaPanProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyCode = async () => {
    if (!shareCode) return;
    try {
      await navigator.clipboard.writeText(shareCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板失败静默：码就在按钮上可见
    }
  };

  return (
    <div className="mt-8 bg-[#121212]/40 backdrop-blur-2xl rounded-3xl border border-white/5 p-6 md:p-8 shadow-2xl shadow-black/20">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-white flex items-center gap-3">
          <span className="w-1 h-6 bg-red-600 rounded-full" />
          网盘资源
        </h2>
        {episodeCount ? (
          <div className="text-sm text-gray-400 bg-black/20 px-3 py-1 rounded-full border border-white/5">
            共 <span className="text-white font-bold">{episodeCount}</span> 集
          </div>
        ) : null}
      </div>

      <div className="space-y-2 md:space-y-3">
        <a
          href={shareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 md:gap-4 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/15 rounded-xl px-4 py-3 transition-all group"
        >
          <BrandBadge brand="quark" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-white truncate group-hover:text-red-400 transition-colors">
              {episodeCount ? `全 ${episodeCount} 集合集` : "短剧全集合集"}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
              <span className="text-xs text-orange-400">夸克网盘</span>
              {shareCode && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCopyCode();
                  }}
                  className="text-[10px] text-sky-300 bg-sky-500/10 hover:bg-sky-500/25 px-1.5 py-0.5 rounded flex items-center gap-1 transition-colors"
                  title="点击复制提取码"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? "已复制" : `提取码 ${shareCode}`}
                </button>
              )}
            </span>
          </span>
          <ExternalLink className="w-4 h-4 text-gray-600 group-hover:text-red-400 transition-colors shrink-0" />
        </a>
      </div>

      <p className="mt-4 text-xs text-gray-600 flex items-center gap-1.5">
        <Link2 className="w-3.5 h-3.5" />
        资源链接来自网络整理，点击跳转对应网盘转存或查看
      </p>
    </div>
  );
}

/** 简介区块（分享夹内 简介.txt） */
export function ShortDramaIntro({ intro }: { intro: string }) {
  return (
    <div className="mt-6">
      <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
        <FileText className="w-5 h-5 text-blue-400" />
        简介
      </h3>
      <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-line">
        {intro}
      </p>
    </div>
  );
}
