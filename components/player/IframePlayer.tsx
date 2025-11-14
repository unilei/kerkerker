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

  // 过滤启用的播放器并按优先级排序，如果视频源有专属播放器则添加到第一位
  const enabledPlayers = useMemo(() => {
    const backupPlayers = players
      .filter(p => p.enabled)
      .sort((a, b) => a.priority - b.priority);
    
    // 如果视频源有专属播放器，添加到第一位
    if (vodSource?.playUrl) {
      const vodSourcePlayer: IframePlayerConfig = {
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
  }, [players, vodSource]);

  const currentPlayer = enabledPlayers[currentPlayerIndex];
  const playerUrl = currentPlayer ? 
    currentPlayer.url + encodeURIComponent(videoUrl) : '';

  // 播放器健康检查
  const startHealthCheck = useCallback(() => {
    if (healthCheckRef.current) clearInterval(healthCheckRef.current);
    
    let checkCount = 0;
    healthCheckRef.current = setInterval(() => {
      checkCount++;
      
      try {
        if (iframeRef.current?.contentWindow) {
          if (healthCheckRef.current) {
            clearInterval(healthCheckRef.current);
          }
          setIsLoading(false);
        }
      } catch {
        // 跨域限制，这是正常的
      }

      if (checkCount > 20) {
        if (healthCheckRef.current) {
          clearInterval(healthCheckRef.current);
        }
      }
    }, 500);
  }, []);

  // 切换到下一个播放器
  const tryNextPlayer = useCallback(() => {
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
    onPlayerSwitch?.(nextIndex);
  }, [currentPlayerIndex, loadAttempts, enabledPlayers, onPlayerSwitch, externalPlayerIndex]);

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
    setTimeout(() => {
      setIsLoading(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
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
    onPlayerSwitch?.(0);
  }, [externalPlayerIndex, onPlayerSwitch]);

  // 监听外部索引变化
  useEffect(() => {
    if (externalPlayerIndex !== undefined) {
      setIsLoading(true);
      setPlayerError(false);
      setLoadAttempts(0);
    }
  }, [externalPlayerIndex]);

  // 清理
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (healthCheckRef.current) clearInterval(healthCheckRef.current);
    };
  }, []);

  // 监听来自iframe的消息
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'player:progress') {
        onProgress?.(event.data.time);
      } else if (event.data.type === 'player:ended') {
        onEnded?.();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onProgress, onEnded]);

  if (!currentPlayer) {
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
              正在加载 {currentPlayer.name}...
            </p>
            <p className="text-gray-400 text-sm">
              尝试 {loadAttempts + 1} / {enabledPlayers.length}
            </p>
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
          title={`播放器 - ${currentPlayer.name}`}
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
            <h3 className="text-white text-xl font-bold mb-2">播放器加载失败</h3>
            <p className="text-gray-400 text-sm mb-6">
              已尝试 {Math.min(loadAttempts + 1, enabledPlayers.length)} / {enabledPlayers.length} 个播放器
              {enabledPlayers.length > 3 && <span className="block mt-1 text-gray-500 text-xs">（为节省时间，最多尝试3个）</span>}
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
