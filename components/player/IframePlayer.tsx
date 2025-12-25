'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { IframePlayer as IframePlayerConfig } from '@/app/api/player-config/route';
import type { VodSource } from '@/types/drama';

interface IframePlayerProps {
  videoUrl: string;
  players: IframePlayerConfig[];
  currentPlayerIndex?: number;
  vodSource?: VodSource | null;
  onProgress?: (time: number) => void;
  onEnded?: () => void;
  onPlayerSwitch?: (playerIndex: number) => void;
}

export function IframePlayer({ 
  videoUrl, 
  players,
  currentPlayerIndex: externalPlayerIndex,
  vodSource,
  onProgress,
  onEnded,
  onPlayerSwitch 
}: IframePlayerProps) {
  const [internalPlayerIndex, setInternalPlayerIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempts, setLoadAttempts] = useState(0);
  const [playerError, setPlayerError] = useState(false);
  
  // 使用外部传入的索引或内部索引
  const currentPlayerIndex = externalPlayerIndex !== undefined ? externalPlayerIndex : internalPlayerIndex;
  
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const healthCheckRef = useRef<NodeJS.Timeout | null>(null);
  const loadTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef<boolean>(true);
  
  // 使用 ref 保存回调，避免消息监听器频繁重新注册
  const onProgressRef = useRef(onProgress);
  const onEndedRef = useRef(onEnded);
  const onPlayerSwitchRef = useRef(onPlayerSwitch);

  // 更新回调 ref
  useEffect(() => {
    onProgressRef.current = onProgress;
    onEndedRef.current = onEnded;
    onPlayerSwitchRef.current = onPlayerSwitch;
  });

  // 通用解析播放器列表
  const backupPlayers = useMemo(() => 
    players.filter(p => p.enabled).sort((a, b) => a.priority - b.priority),
    [players]
  );
  
  // 检查是否禁用了解析接口（usePlayUrl: false 表示直接播放原始链接）
  const disableParseUrl = vodSource?.usePlayUrl === false;
  
  // 过滤启用的播放器并按优先级排序
  const enabledPlayers = useMemo(() => {
    // 如果禁用了解析接口，返回空数组（将直接播放原始链接）
    if (disableParseUrl) {
      return [];
    }
    
    // 检查视频源是否有专属播放器（usePlayUrl 默认为 true）
    const shouldUsePlayUrl = vodSource?.playUrl && (vodSource.usePlayUrl !== false);
    
    if (shouldUsePlayUrl && vodSource?.playUrl) {
      const vodSourcePlayer: IframePlayerConfig = {
        id: `vod_source_${vodSource.key}`,
        name: `${vodSource.name}播放器`,
        url: vodSource.playUrl,
        priority: 0,
        timeout: 15000, // 给视频源播放器更多时间
        enabled: true,
      };
      // 视频源播放器 + 通用播放器作为备选
      return [vodSourcePlayer, ...backupPlayers];
    }
    
    return backupPlayers;
  }, [vodSource, backupPlayers, disableParseUrl]);

  const currentPlayer = enabledPlayers[currentPlayerIndex];
  // 如果禁用解析接口，直接使用原始视频链接；否则使用解析接口+视频链接
  const playerUrl = disableParseUrl 
    ? videoUrl 
    : (currentPlayer ? currentPlayer.url + encodeURIComponent(videoUrl) : '');

  // 播放器健康检查
  const startHealthCheck = useCallback(() => {
    if (healthCheckRef.current) clearInterval(healthCheckRef.current);
    
    let checkCount = 0;
    healthCheckRef.current = setInterval(() => {
      // 检查组件是否已卸载
      if (!isMountedRef.current) {
        if (healthCheckRef.current) {
          clearInterval(healthCheckRef.current);
          healthCheckRef.current = null;
        }
        return;
      }
      
      checkCount++;
      
      try {
        if (iframeRef.current?.contentWindow) {
          if (healthCheckRef.current) {
            clearInterval(healthCheckRef.current);
            healthCheckRef.current = null;
          }
          setIsLoading(false);
        }
      } catch {
        // 跨域限制，这是正常的
      }

      if (checkCount > 20) {
        if (healthCheckRef.current) {
          clearInterval(healthCheckRef.current);
          healthCheckRef.current = null;
        }
      }
    }, 500);
  }, []);

  // 切换到下一个播放器
  const tryNextPlayer = useCallback(() => {
    if (!isMountedRef.current) return;
    
    const maxAttempts = Math.min(enabledPlayers.length, 3); // 最多尝试3个播放器
    
    if (loadAttempts >= maxAttempts - 1) {
      setPlayerError(true);
      setIsLoading(false);
      return;
    }

    const nextIndex = (currentPlayerIndex + 1) % enabledPlayers.length;
    
    if (externalPlayerIndex === undefined) {
      setInternalPlayerIndex(nextIndex);
    }
    setLoadAttempts(prev => prev + 1);
    setIsLoading(true);
    onPlayerSwitchRef.current?.(nextIndex);
  }, [currentPlayerIndex, loadAttempts, enabledPlayers.length, externalPlayerIndex]);

  // 超时检测
  useEffect(() => {
    if (!isLoading || playerError || !currentPlayer) return;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    timeoutRef.current = setTimeout(() => {
      tryNextPlayer();
    }, currentPlayer.timeout);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isLoading, playerError, currentPlayer, tryNextPlayer]);

  // iframe加载完成
  const handleIframeLoad = useCallback(() => {
    // 清理之前的加载定时器
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    
    loadTimerRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      setIsLoading(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      loadTimerRef.current = null;
    }, 300);

    startHealthCheck();
  }, [startHealthCheck]);

  // iframe加载错误
  const handleIframeError = useCallback(() => {
    tryNextPlayer();
  }, [tryNextPlayer]);

  // 重试
  const retry = useCallback(() => {
    setPlayerError(false);
    if (externalPlayerIndex === undefined) {
      setInternalPlayerIndex(0);
    }
    setLoadAttempts(0);
    setIsLoading(true);
    onPlayerSwitchRef.current?.(0);
  }, [externalPlayerIndex]);

  // 监听外部索引变化
  useEffect(() => {
    if (externalPlayerIndex !== undefined) {
      setIsLoading(true);
      setPlayerError(false);
      setLoadAttempts(0);
    }
  }, [externalPlayerIndex]);

  // 监听 vodSource 变化，重置状态
  useEffect(() => {
    setPlayerError(false);
    setLoadAttempts(0);
    if (externalPlayerIndex === undefined) {
      setInternalPlayerIndex(0);
    }
  }, [vodSource, externalPlayerIndex]);

  // 设置 mounted 状态
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 清理所有定时器
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (healthCheckRef.current) {
        clearInterval(healthCheckRef.current);
        healthCheckRef.current = null;
      }
      if (loadTimerRef.current) {
        clearTimeout(loadTimerRef.current);
        loadTimerRef.current = null;
      }
    };
  }, []);

  // 监听来自iframe的消息（使用 ref 避免频繁重新注册）
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!isMountedRef.current) return;
      
      if (event.data.type === 'player:progress') {
        onProgressRef.current?.(event.data.time);
      } else if (event.data.type === 'player:ended') {
        onEndedRef.current?.();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // 当没有可用播放器且不是直接播放模式时，显示错误
  if (!currentPlayer && !disableParseUrl) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <p className="text-white">没有可用的播放器</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black">
      {/* Loading状态 */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-20">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-700 border-t-red-600 mx-auto mb-4" />
            <p className="text-white text-lg mb-2">
              {disableParseUrl ? '正在加载视频...' : `正在加载 ${currentPlayer?.name}...`}
            </p>
            {!disableParseUrl && (
              <p className="text-gray-400 text-sm">
                尝试 {loadAttempts + 1} / {enabledPlayers.length}
              </p>
            )}
          </div>
        </div>
      )}

      {/* 播放器iframe */}
      {!playerError && playerUrl && (
        <iframe
          ref={iframeRef}
          key={playerUrl}
          src={playerUrl}
          className="w-full h-full"
          allowFullScreen
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
          title={disableParseUrl ? '直接播放' : `播放器 - ${currentPlayer?.name}`}
          onLoad={handleIframeLoad}
          onError={handleIframeError}
        />
      )}

      {/* 错误状态 */}
      {playerError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/95 z-20">
          <div className="text-center px-6 max-w-md">
            <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-10 h-10 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-white text-xl font-bold mb-2">
              {disableParseUrl ? '视频加载失败' : '播放器加载失败'}
            </h3>
            <p className="text-gray-400 text-sm mb-6">
              {disableParseUrl ? (
                <span>无法直接播放此视频，可能是跨域限制或视频源不支持</span>
              ) : (
                <>
                  已尝试 {Math.min(loadAttempts + 1, enabledPlayers.length)} / {enabledPlayers.length} 个播放器
                  {enabledPlayers.length > 3 && <span className="block mt-1 text-gray-500 text-xs">（为节省时间，最多尝试3个）</span>}
                </>
              )}
              <span className="block mt-2">建议：尝试切换视频源或稍后重试</span>
            </p>
            <div className="space-y-3">
              <button
                onClick={retry}
                className="w-full px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors font-medium"
              >
                重新尝试
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
