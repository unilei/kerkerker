'use client';

import { useState, useRef, useEffect } from 'react';

interface SourceInfo {
  source_key: string;
  source_name: string;
  vod_id: string | number;
  vod_name: string;
  match_confidence: 'high' | 'medium' | 'low';
}

interface SourceSelectorProps {
  sources: SourceInfo[];
  currentSourceKey: string | null;
  onSourceChange: (sourceKey: string, vodId: string | number) => void;
}

export function SourceSelector({ sources, currentSourceKey, onSourceChange }: SourceSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // 如果只有一个或没有源，不显示
  if (sources.length <= 1) {
    return null;
  }

  const currentSource = sources.find(s => s.source_key === currentSourceKey);

  const getConfidenceBadge = (confidence: 'high' | 'medium' | 'low') => {
    const badges = {
      high: { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/50', label: '精准' },
      medium: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/50', label: '相似' },
      low: { bg: 'bg-gray-500/20', text: 'text-gray-400', border: 'border-gray-500/50', label: '模糊' },
    };
    const badge = badges[confidence];
    return (
      <span className={`text-xs px-2 py-0.5 rounded border ${badge.bg} ${badge.text} ${badge.border} font-medium`}>
        {badge.label}
      </span>
    );
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* 触发按钮 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="group flex items-center space-x-2 px-3 md:px-4 py-2 bg-white/10 hover:bg-white/20 rounded-full transition-all hover:scale-105 text-white text-xs md:text-sm font-medium shadow-lg backdrop-blur-sm"
        aria-label="切换视频源"
        aria-expanded={isOpen}
      >
        <svg
          className={`w-5 h-5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
          />
        </svg>
        <span className="hidden sm:inline">{sources.length} 个播放源</span>
        <span className="sm:hidden">{sources.length}</span>
        {currentSource && (
          <span className="hidden md:inline text-gray-400">
            · {currentSource.source_name}
          </span>
        )}
      </button>

      {/* 下拉菜单 */}
      {isOpen && (
        <div className="absolute right-0 mt-3 w-72 md:w-80 bg-gray-900/98 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-700 overflow-hidden animate-fade-in z-50">
          {/* 头部 */}
          <div className="p-3 border-b border-gray-800 bg-gradient-to-r from-gray-800/50 to-transparent">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center space-x-2">
                <svg className="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
                </svg>
                <span>选择播放源</span>
              </h3>
              <span className="text-xs text-gray-500">
                {sources.filter(s => s.match_confidence === 'high').length} 个精准匹配
              </span>
            </div>
          </div>

          {/* 源列表 */}
          <div className="max-h-[60vh] overflow-y-auto">
            {sources.map((source, index) => {
              const isCurrent = source.source_key === currentSourceKey;
              return (
                <button
                  key={source.source_key}
                  onClick={() => {
                    if (!isCurrent) {
                      onSourceChange(source.source_key, source.vod_id);
                    }
                    setIsOpen(false);
                  }}
                  className={`w-full text-left px-4 py-3 transition-all ${
                    isCurrent
                      ? 'bg-red-600/20 border-l-4 border-red-600'
                      : 'hover:bg-white/5 border-l-4 border-transparent'
                  } ${index !== sources.length - 1 ? 'border-b border-gray-800/50' : ''}`}
                  disabled={isCurrent}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {/* 源名称 */}
                      <div className="flex items-center space-x-2 mb-1">
                        <p className={`text-sm font-semibold truncate ${
                          isCurrent ? 'text-red-400' : 'text-white'
                        }`}>
                          {source.source_name}
                        </p>
                        {isCurrent && (
                          <span className="flex-shrink-0 text-red-400">
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          </span>
                        )}
                      </div>
                      {/* 视频名称 */}
                      <p className="text-xs text-gray-400 truncate" title={source.vod_name}>
                        {source.vod_name}
                      </p>
                    </div>

                    {/* 匹配度标签 */}
                    <div className="flex-shrink-0">
                      {getConfidenceBadge(source.match_confidence)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* 底部提示 */}
          <div className="p-3 border-t border-gray-800 bg-gray-900/50">
            <p className="text-xs text-gray-500 flex items-start space-x-2">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              <span>不同播放源的清晰度和加载速度可能不同</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
