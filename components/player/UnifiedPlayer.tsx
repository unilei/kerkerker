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
  const previousModeRef = useRef<'iframe' | 'local' | undefined>(undefined);

  // 加载播放器配置
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch('/api/player-config');
        const result = await response.json();
        
        if (result.code === 200 && result.data) {
          setPlayerConfig(result.data);
          
          // 如果外部传入了mode，使用外部的；否则根据配置决定
          if (externalMode) {
            setCurrentMode(externalMode);
          } else if (result.data.mode === 'auto') {
            // 自动模式：智能选择播放器
            const selectedMode = selectBestPlayerMode(result.data);
            setCurrentMode(selectedMode);
          } else {
            setCurrentMode(result.data.mode);
          }
        }
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[Player Config Load Failed]', error);
        }
        setCurrentMode(externalMode || 'iframe');
      } finally {
        setIsLoading(false);
      }
    };

    loadConfig();
  }, [externalMode]);

  // 监听外部mode变化，使用ref避免无限循环
  useEffect(() => {
    // 只有当externalMode真正改变时才触发
    if (externalMode && externalMode !== previousModeRef.current) {
      // 更新ref
      previousModeRef.current = externalMode;
      
      // 如果currentMode已经有值且与新模式不同，先清空以卸载旧播放器
      if (currentMode && currentMode !== externalMode) {
        setCurrentMode(null);
        
        // 延迟后设置新模式
        const timer = setTimeout(() => {
          setCurrentMode(externalMode);
        }, 100);
        
        return () => clearTimeout(timer);
      } else if (!currentMode) {
        // 首次加载，直接设置
        setCurrentMode(externalMode);
      }
    }
  }, [externalMode, currentMode]);

  // 处理播放器错误（降级）
  const handlePlayerError = useCallback(() => {
    if (currentMode === 'local') {
      setCurrentMode('iframe');
    }
  }, [currentMode]);

  // 处理播放器切换（用于iframe模式）
  const handlePlayerSwitch = useCallback((playerIndex: number) => {
    onIframePlayerSwitch?.(playerIndex);
  }, [onIframePlayerSwitch]);

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

  return (
    <div className="relative w-full h-full bg-black">
      {/* 播放器 - 使用key强制重新挂载，避免切换时两个播放器同时存在 */}
      {currentMode === 'iframe' && (
        <IframePlayer
          key={`iframe-${videoUrl}`}
          videoUrl={videoUrl}
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
          key={`local-${videoUrl}`}
          videoUrl={videoUrl}
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
