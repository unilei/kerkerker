'use client';

import { useState, useRef, useEffect } from 'react';
import type { PlayerConfig } from '@/app/api/player-config/route';
import type { VodSource } from '@/types/drama';

interface PlayerSettingsPanelProps {
  playerConfig: PlayerConfig;
  currentMode: 'iframe' | 'local';
  currentIframePlayerIndex: number;
  vodSource?: VodSource | null; // 当前视频源
  onModeChange: (mode: 'iframe' | 'local') => void;
  onIframePlayerChange: (index: number) => void;
}

export function PlayerSettingsPanel({
  playerConfig,
  currentMode,
  currentIframePlayerIndex,
  vodSource,
  onModeChange,
  onIframePlayerChange,
}: PlayerSettingsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // 切换到iframe模式时，自动选择视频源的专属播放器
  const handleModeChange = (mode: 'iframe' | 'local') => {
    // 检查视频源是否启用了播放地址解析（usePlayUrl 默认为 true）
    const shouldUsePlayUrl = vodSource?.playUrl && (vodSource.usePlayUrl !== false);
    if (mode === 'iframe' && shouldUsePlayUrl) {
      // 视频源专属播放器始终在第一位（索引0）
      onIframePlayerChange(0);
    }
    onModeChange(mode);
  };

  // 点击外部关闭面板
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
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

  // ESC 键关闭
  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEsc);
    }

    return () => {
      document.removeEventListener('keydown', handleEsc);
    };
  }, [isOpen]);

  // 检查是否禁用了解析接口（usePlayUrl: false 表示直接播放原始链接）
  const disableParseUrl = vodSource?.usePlayUrl === false;
  
  // 计算实际启用的播放器列表（与IframePlayer.tsx保持一致）
  const enabledIframePlayers = (() => {
    // 如果禁用了解析接口，返回空数组
    if (disableParseUrl) {
      return [];
    }
    
    const backupPlayers = playerConfig.iframePlayers
      .filter(p => p.enabled)
      .sort((a, b) => a.priority - b.priority);
    
    // 检查视频源是否有专属播放器（usePlayUrl 默认为 true）
    const shouldUsePlayUrl = vodSource?.playUrl && (vodSource.usePlayUrl !== false);
    
    if (shouldUsePlayUrl && vodSource?.playUrl) {
      const vodSourcePlayer = {
        id: `vod_source_${vodSource.key}`,
        name: `${vodSource.name}播放器`,
        url: vodSource.playUrl,
        priority: 0,
        timeout: 10000,
        enabled: true,
      };
      return [vodSourcePlayer, ...backupPlayers];
    }
    
    return backupPlayers;
  })();

  return (
    <div className="relative" ref={panelRef}>
      {/* 触发按钮 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="group p-2 hover:bg-white/20 rounded-full transition-all hover:scale-110 text-white shadow-lg"
        aria-label="播放器设置"
        aria-expanded={isOpen}
      >
        <svg
          className={`w-6 h-6 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>

      {/* 设置面板 */}
      {isOpen && (
        <div className="absolute top-14 right-0 w-80 md:w-96 bg-black/98 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-800 overflow-hidden z-50 animate-fade-in">
          {/* 标题栏 */}
          <div className="flex items-center justify-between p-4 border-b border-gray-800 bg-gradient-to-r from-gray-900/50 to-transparent">
            <div className="flex items-center space-x-2">
              <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              <h3 className="text-lg font-bold text-white">播放器设置</h3>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1.5 hover:bg-white/10 rounded-full transition-colors"
              aria-label="关闭"
            >
              <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {/* 播放器模式选择 */}
            <div className="p-4 border-b border-gray-800">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  播放器模式
                </h4>
                <span className="text-xs text-gray-500 bg-gray-800/50 px-2 py-1 rounded">
                  {currentMode === 'iframe' ? 'iframe' : '本地'}
                </span>
              </div>
              
              <div className="space-y-2">
                {/* iframe 播放器 */}
                <button
                  onClick={() => handleModeChange('iframe')}
                  className={`w-full text-left px-4 py-3 rounded-lg transition-all group ${
                    currentMode === 'iframe'
                      ? 'bg-red-600 text-white ring-2 ring-red-400 shadow-lg shadow-red-500/20'
                      : 'bg-gray-800/50 text-gray-300 hover:bg-gray-800 hover:scale-[1.02]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      <div>
                        <div className="font-medium">iframe 播放器</div>
                        <div className={`text-xs mt-1 ${currentMode === 'iframe' ? 'text-red-100' : 'text-gray-500'}`}>
                          兼容性好，无需代理
                        </div>
                      </div>
                    </div>
                    {currentMode === 'iframe' && (
                      <span className="text-lg">✓</span>
                    )}
                  </div>
                </button>
                
                {/* 本地播放器 */}
                <button
                  onClick={() => playerConfig.enableProxy && handleModeChange('local')}
                  disabled={!playerConfig.enableProxy}
                  className={`w-full text-left px-4 py-3 rounded-lg transition-all group ${
                    currentMode === 'local'
                      ? 'bg-red-600 text-white ring-2 ring-red-400 shadow-lg shadow-red-500/20'
                      : playerConfig.enableProxy
                      ? 'bg-gray-800/50 text-gray-300 hover:bg-gray-800 hover:scale-[1.02]'
                      : 'bg-gray-900/50 text-gray-600 cursor-not-allowed opacity-60'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div>
                        <div className="font-medium">本地播放器</div>
                        <div className={`text-xs mt-1 ${
                          currentMode === 'local' 
                            ? 'text-red-100' 
                            : playerConfig.enableProxy 
                            ? 'text-gray-500' 
                            : 'text-gray-600'
                        }`}>
                          {playerConfig.enableProxy ? '完全控制，高级功能' : '需要启用代理服务'}
                        </div>
                      </div>
                    </div>
                    {currentMode === 'local' && (
                      <span className="text-lg">✓</span>
                    )}
                    {!playerConfig.enableProxy && (
                      <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    )}
                  </div>
                </button>
              </div>
            </div>

            {/* 直接播放模式提示 (usePlayUrl: false) */}
            {currentMode === 'iframe' && disableParseUrl && (
              <div className="p-4 border-b border-gray-800">
                <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  播放模式
                </h4>
                <div className="p-4 bg-gradient-to-r from-green-600/20 to-teal-600/20 border border-green-500/30 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <div className="shrink-0 w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center">
                      <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium">直接播放</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        不使用解析接口，直接播放原始视频链接
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 当前使用的播放器 */}
            {currentMode === 'iframe' && enabledIframePlayers.length > 0 && (
              <div className="p-4 border-b border-gray-800">
                <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  当前播放器
                </h4>
                <div className="p-4 bg-gradient-to-r from-blue-600/20 to-purple-600/20 border border-blue-500/30 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <div className="shrink-0 w-10 h-10 bg-blue-500/20 rounded-full flex items-center justify-center">
                      <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-medium truncate">
                          {enabledIframePlayers[currentIframePlayerIndex]?.name || '未知播放器'}
                        </p>
                        {enabledIframePlayers[currentIframePlayerIndex]?.id.startsWith('vod_source_') && (
                          <span className="shrink-0 text-xs px-2 py-0.5 bg-green-500/20 text-green-400 border border-green-500/30 rounded">
                            源推荐
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        优先级 {enabledIframePlayers[currentIframePlayerIndex]?.priority} · 超时 {enabledIframePlayers[currentIframePlayerIndex]?.timeout}ms
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 切换播放器 */}
            {currentMode === 'iframe' && enabledIframePlayers.length > 0 && (
              <div className="p-4 border-b border-gray-800">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                    切换播放器
                  </h4>
                  <span className="text-xs text-gray-500">
                    {enabledIframePlayers.length} 个可用
                  </span>
                </div>
                <p className="text-xs text-gray-500 mb-3 flex items-start space-x-2">
                  <svg className="w-4 h-4 shrink-0 mt-0.5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  <span>无法加载时将自动切换到下一个播放器</span>
                </p>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {enabledIframePlayers.map((player, index) => {
                    const isFromVodSource = player.id.startsWith('vod_source_');
                    return (
                      <button
                        key={player.id}
                        onClick={() => onIframePlayerChange(index)}
                        className={`w-full text-left px-4 py-2.5 rounded-lg transition-all ${
                          currentIframePlayerIndex === index
                            ? 'bg-red-600 text-white font-medium shadow-md'
                            : 'bg-gray-800/50 text-gray-300 hover:bg-gray-800'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              currentIframePlayerIndex === index
                                ? 'bg-red-700 text-white'
                                : 'bg-gray-700 text-gray-400'
                            }`}>
                              {player.priority}
                            </span>
                            <span className="truncate">{player.name}</span>
                            {isFromVodSource && (
                              <span className={`text-xs px-1.5 py-0.5 rounded ${
                                currentIframePlayerIndex === index
                                  ? 'bg-yellow-500/20 text-yellow-200 border border-yellow-400/30'
                                  : 'bg-green-500/20 text-green-400 border border-green-500/30'
                              }`}>
                                源推荐
                              </span>
                            )}
                          </div>
                          {currentIframePlayerIndex === index && (
                            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 快捷键说明 */}
            <div className="p-4 bg-gradient-to-b from-transparent to-gray-900/30">
              <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3 flex items-center space-x-2">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
                <span>快捷键</span>
              </h4>
              <div className="space-y-2">
                {[
                  { key: '← / →', desc: '上一集 / 下一集' },
                  { key: 'S', desc: '打开/关闭设置' },
                  { key: 'ESC', desc: '返回首页' },
                ].map((shortcut, index) => (
                  <div key={index} className="flex justify-between items-center text-xs group hover:bg-gray-800/30 p-2 rounded transition-colors">
                    <kbd className="px-2 py-1 bg-gray-800 text-gray-300 rounded border border-gray-700 font-mono font-semibold group-hover:border-gray-600">
                      {shortcut.key}
                    </kbd>
                    <span className="text-gray-400 group-hover:text-gray-300">{shortcut.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
