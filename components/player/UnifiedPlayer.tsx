'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { IframePlayer } from './IframePlayer';
import { LocalHlsPlayer } from './LocalHlsPlayer';
import type { PlayerConfig } from '@/app/api/player-config/route';
import type { VodSource } from '@/types/drama';

// 智能选择最佳播放器模式
function selectBestPlayerMode(config: PlayerConfig): 'iframe' | 'local' {
  // 1. 检查是否有可用的iframe播放器
  const hasEnabledIframePlayers = config.iframePlayers.some(p => p.enabled);

  // 2. 检查是否启用了代理（本地播放器必需）
  const proxyEnabled = config.enableProxy;

  // 3. 检查浏览器是否支持HLS（MediaSource API）
  const supportsHLS = typeof window !== 'undefined' &&
    'MediaSource' in window;

  // 决策逻辑：
  // - 如果启用代理且浏览器支持HLS，优先使用本地播放器（功能更强）
  // - 如果没有启用代理或不支持HLS，使用iframe播放器
  // - 如果iframe播放器也没有可用的，降级到本地播放器尝试
  if (proxyEnabled && supportsHLS) {
    return 'local';
  }

  if (hasEnabledIframePlayers) {
    return 'iframe';
  }

  // 兜底：使用本地播放器
  return 'local';
}

interface UnifiedPlayerProps {
  videoUrl: string;
  title: string;
  mode?: 'iframe' | 'local';
  currentIframePlayerIndex?: number;
  vodSource?: VodSource | null;
  onProgress?: (time: number) => void;
  onEnded?: () => void;
  onIframePlayerSwitch?: (playerIndex: number) => void;
}

export function UnifiedPlayer({
  videoUrl,
  title,
  mode: externalMode,
  currentIframePlayerIndex,
  vodSource,
  onProgress,
  onEnded,
  onIframePlayerSwitch,
}: UnifiedPlayerProps) {
  const [playerConfig, setPlayerConfig] = useState<PlayerConfig | null>(null);
  const [currentMode, setCurrentMode] = useState<'iframe' | 'local' | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [parsedVideoUrl, setParsedVideoUrl] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);  // 解析错误信息
  const previousModeRef = useRef<'iframe' | 'local' | undefined>(undefined);
  const switchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const lastParsedUrlRef = useRef<string>('');

  // 使用 ref 保存回调，避免频繁重建
  const onIframePlayerSwitchRef = useRef(onIframePlayerSwitch);

  // 更新回调 ref
  useEffect(() => {
    onIframePlayerSwitchRef.current = onIframePlayerSwitch;
  });

  // 设置 mounted 状态
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 解析视频URL（如果源有parseProxy配置）
  useEffect(() => {
    const parseVideoUrl = async () => {
      // 重置错误状态
      setParseError(null);

      // 如果URL没变，不需要重新解析
      if (lastParsedUrlRef.current === videoUrl) {
        return;
      }

      // 如果没有parseProxy，直接使用原始URL
      if (!vodSource?.parseProxy) {
        setParsedVideoUrl(videoUrl);
        lastParsedUrlRef.current = videoUrl;
        return;
      }

      setIsParsing(true);
      try {
        const response = await fetch('/api/drama/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: videoUrl,
            source: vodSource,
          }),
        });

        if (!isMountedRef.current) return;

        const result = await response.json();
        if (result.code === 200 && result.data?.url) {
          setParsedVideoUrl(result.data.url);
          lastParsedUrlRef.current = videoUrl;
        } else {
          // 解析失败，显示错误
          const errorMsg = result.msg || result.data?.error || '视频解析失败';
          console.warn('[Video Parse]', errorMsg);
          setParseError(errorMsg);
          // 不设置 parsedVideoUrl，保持 null 状态
        }
      } catch (error) {
        if (!isMountedRef.current) return;
        console.warn('[Video Parse] 请求失败:', error);
        setParseError('视频解析请求失败，请检查网络连接');
      } finally {
        if (isMountedRef.current) {
          setIsParsing(false);
        }
      }
    };

    parseVideoUrl();
  }, [videoUrl, vodSource]);

  // 使用外部传入的播放模式
  const effectiveMode: 'iframe' | 'local' | undefined = externalMode;

  // 加载播放器配置（只在挂载时加载一次）
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch('/api/player-config');
        const result = await response.json();

        if (!isMountedRef.current) return;

        if (result.code === 200 && result.data) {
          setPlayerConfig(result.data);

          // 如果有 effectiveMode（包括 parseProxy 强制 local），优先使用
          if (effectiveMode) {
            setCurrentMode(effectiveMode);
          } else if (result.data.mode === 'auto') {
            // 自动模式：智能选择播放器
            const selectedMode = selectBestPlayerMode(result.data);
            setCurrentMode(selectedMode);
          } else {
            setCurrentMode(result.data.mode);
          }
        }
      } catch (error) {
        if (!isMountedRef.current) return;

        if (process.env.NODE_ENV === 'development') {
          console.error('[Player Config Load Failed]', error);
        }
        setCurrentMode(effectiveMode || 'iframe');
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    };

    loadConfig();
  }, [effectiveMode]); // 当 effectiveMode 变化时重新加载

  // 监听外部mode变化，使用ref避免无限循环
  useEffect(() => {
    // 如果 effectiveMode 为 undefined，不做处理（使用配置中的模式）
    if (effectiveMode === undefined) {
      return;
    }

    // 检查 effectiveMode 是否真正改变
    if (effectiveMode !== previousModeRef.current) {
      // 清理之前的定时器
      if (switchTimerRef.current) {
        clearTimeout(switchTimerRef.current);
        switchTimerRef.current = null;
      }

      // 如果currentMode已经有值且与新模式不同，先清空以卸载旧播放器
      if (currentMode && currentMode !== effectiveMode) {
        setCurrentMode(null);

        // 延迟后设置新模式
        switchTimerRef.current = setTimeout(() => {
          if (!isMountedRef.current) return;
          setCurrentMode(effectiveMode);
          // 在成功设置新模式后才更新 ref
          previousModeRef.current = effectiveMode;
          switchTimerRef.current = null;
        }, 100);
      } else if (!currentMode) {
        // 首次加载，直接设置
        setCurrentMode(effectiveMode);
        // 更新ref
        previousModeRef.current = effectiveMode;
      }
    }

    // 清理函数
    return () => {
      if (switchTimerRef.current) {
        clearTimeout(switchTimerRef.current);
        switchTimerRef.current = null;
      }
    };
  }, [effectiveMode, currentMode]);

  // 处理播放器错误（降级）
  const handlePlayerError = useCallback(() => {
    // 使用 setCurrentMode 的函数式更新，避免依赖 currentMode
    setCurrentMode(prevMode => {
      if (prevMode === 'local') {
        return 'iframe';
      }
      return prevMode;
    });
  }, []);

  // 处理播放器切换（用于iframe模式）
  const handlePlayerSwitch = useCallback((playerIndex: number) => {
    onIframePlayerSwitchRef.current?.(playerIndex);
  }, []);

  if (isLoading || !playerConfig) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-700 border-t-red-600 mx-auto mb-4" />
          <p className="text-white text-lg">加载播放器配置...</p>
        </div>
      </div>
    );
  }

  // 切换播放器时显示过渡
  if (!currentMode) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-700 border-t-blue-500 mx-auto mb-3" />
          <p className="text-white text-base">切换播放器...</p>
        </div>
      </div>
    );
  }

  // 解析错误时显示错误提示
  if (parseError) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center px-6 max-w-md">
          <div className="w-16 h-16 bg-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h3 className="text-white text-lg font-semibold mb-2">当前线路存在问题</h3>
          <p className="text-gray-400 text-sm mb-4">{parseError}</p>
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 mb-4">
            <p className="text-blue-300 text-xs flex items-start gap-2">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              <span>请点击顶部的「播放源」按钮切换到其他线路尝试播放</span>
            </p>
          </div>
          <button
            onClick={() => {
              setParseError(null);
              setParsedVideoUrl(null);
              lastParsedUrlRef.current = '';
            }}
            className="px-6 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg transition-colors font-medium"
          >
            重新尝试
          </button>
        </div>
      </div>
    );
  }

  // 解析视频URL时显示加载
  if (isParsing || !parsedVideoUrl) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-700 border-t-amber-500 mx-auto mb-3" />
          <p className="text-white text-base">解析视频地址...</p>
        </div>
      </div>
    );
  }

  // 使用解析后的URL
  const finalVideoUrl = parsedVideoUrl;

  return (
    <div className="relative w-full h-full bg-black">
      {/* 播放器 - 使用key强制重新挂载，避免切换时两个播放器同时存在 */}
      {currentMode === 'iframe' && (
        <IframePlayer
          key={`iframe-${currentIframePlayerIndex}-${finalVideoUrl}`}
          videoUrl={finalVideoUrl}
          players={playerConfig.iframePlayers}
          currentPlayerIndex={currentIframePlayerIndex}
          vodSource={vodSource}
          onProgress={onProgress}
          onEnded={onEnded}
          onPlayerSwitch={handlePlayerSwitch}
        />
      )}

      {currentMode === 'local' && (
        <LocalHlsPlayer
          key={`local-${finalVideoUrl}`}
          videoUrl={finalVideoUrl}
          title={title}
          settings={playerConfig.localPlayerSettings}
          onProgress={onProgress}
          onEnded={onEnded}
          onError={handlePlayerError}
        />
      )}
    </div>
  );
}
