'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type Artplayer from 'artplayer';
import type Hls from 'hls.js';
import { LocalPlayerSettings } from '@/app/api/player-config/route';

// 错误类型定义
type ErrorType = 'network' | 'media' | 'key' | 'manifest' | 'fragment' | 'unknown';

interface PlayerError {
  type: ErrorType;
  message: string;
  canRetry: boolean;
}

// HLS错误数据接口
interface HlsErrorData {
  type?: string;
  details?: string;
  fatal?: boolean;
  reason?: string;
  response?: {
    code?: number;
    text?: string;
  };
  frag?: unknown;
  level?: number;
}

interface LocalHlsPlayerProps {
  videoUrl: string;
  title: string;
  settings: LocalPlayerSettings;
  onProgress?: (time: number) => void;
  onEnded?: () => void;
  onError?: () => void;
}

export function LocalHlsPlayer({
  videoUrl,
  title,
  settings,
  onProgress,
  onEnded,
  onError,
}: LocalHlsPlayerProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<PlayerError | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<Artplayer | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const networkRetryCount = useRef<number>(0);
  const mediaRetryCount = useRef<number>(0);
  const keyErrorCount = useRef<number>(0);
  
  const MAX_NETWORK_RETRY = 3;
  const MAX_MEDIA_RETRY = 2;
  const MAX_KEY_ERROR = 5; // 密钥错误最多容忍5次

  // 确保在客户端执行
  useEffect(() => {
    setIsClient(true);
  }, []);

  // 获取代理后的URL
  const getProxiedUrl = useCallback((url: string) => {
    if (!url) return '';
    if (url.startsWith('/api/video-proxy/')) return url;
    return `/api/video-proxy/${encodeURIComponent(url)}`;
  }, []);

  // 设置错误状态
  const setPlayerError = useCallback((type: ErrorType, message: string, canRetry: boolean = false) => {
    if (!isMountedRef.current) return;
    setError({ type, message, canRetry });
    setIsLoading(false);
    
    if (!canRetry) {
      onError?.();
    }
  }, [onError]);

  // 重试播放
  const handleRetry = useCallback(() => {
    setError(null);
    setIsLoading(true);
    setRetryCount(prev => prev + 1);
    networkRetryCount.current = 0;
    mediaRetryCount.current = 0;
    keyErrorCount.current = 0;
  }, []);

  // 初始化播放器
  useEffect(() => {
    if (!isClient || !containerRef.current || !videoUrl) return;

    // 动态导入（仅在客户端）
    const initPlayer = async () => {
      try {
        // 动态导入Artplayer和HLS.js
        const [ArtplayerModule, HlsModule] = await Promise.all([
          import('artplayer'),
          import('hls.js'),
        ]);

        const Artplayer = ArtplayerModule.default;
        const Hls = HlsModule.default;

        // 清理旧实例
        if (artRef.current) {
          artRef.current.destroy();
          artRef.current = null;
        }

        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }

        // HLS配置
        const hlsConfig = {
          debug: false,
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          fragLoadingMaxRetry: 2, // 减少片段重试次数
          fragLoadingMaxRetryTimeout: 10000, // 减少超时时间
          manifestLoadingMaxRetry: 2, // 减少清单重试次数
          manifestLoadingMaxRetryTimeout: 10000,
          levelLoadingMaxRetry: 2,
          levelLoadingMaxRetryTimeout: 10000,
        };

        // 创建ArtPlayer实例
        const art = new Artplayer({
          container: containerRef.current as HTMLDivElement,
          url: getProxiedUrl(videoUrl),
          type: 'm3u8',
          volume: 0.8,
          isLive: false,
          muted: false,
          autoplay: true,
          pip: true,
          screenshot: true,
          setting: true,
          fullscreen: true,
          fullscreenWeb: true,
          miniProgressBar: true,
          playsInline: true,
          theme: settings.theme || '#ef4444',
          lang: 'zh-cn',
          moreVideoAttr: {
            crossOrigin: 'anonymous',
          },
          customType: {
            m3u8: (video: HTMLVideoElement, url: string) => {
              const hls = new Hls(hlsConfig);
              hlsRef.current = hls;

              hls.loadSource(url);
              hls.attachMedia(video);

              // Manifest加载完成
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                // 检查组件是否已卸载和元素是否在DOM中
                if (isMountedRef.current && video && document.contains(video)) {
                  const playPromise = video.play();
                  if (playPromise !== undefined) {
                    playPromise.catch(e => {
                      // 忽略中止错误
                      if (e.name !== 'AbortError' && process.env.NODE_ENV === 'development') {
                        console.log('[Autoplay Failed]', e);
                      }
                    });
                  }
                }
              });

              // 错误处理
              hls.on(Hls.Events.ERROR, (_event: string, data: HlsErrorData) => {
                // 处理密钥加载错误（通常是404）
                if (data.details === 'keyLoadError' || data.details === 'keyLoadTimeOut') {
                  keyErrorCount.current++;
                  
                  if (keyErrorCount.current > MAX_KEY_ERROR) {
                    const errorMsg = data.response?.code === 404 
                      ? '视频加密密钥不存在（404），无法播放此视频'
                      : '视频加密密钥加载失败，无法播放';
                    setPlayerError('key', errorMsg, false);
                    hls.stopLoad();
                    return;
                  }
                  return;
                }

                // 处理清单加载错误
                if (data.details === 'manifestLoadError') {
                  const is404 = data.response?.code === 404;
                  const errorMsg = is404 
                    ? '视频文件不存在（404）'
                    : `视频清单加载失败${data.response?.code ? ` (${data.response.code})` : ''}`;
                  setPlayerError('manifest', errorMsg, !is404);
                  return;
                }

                // 处理片段加载错误
                if (data.details === 'fragLoadError' && data.response?.code === 404) {
                  setPlayerError('fragment', '视频片段不存在（404），该视频可能已损坏', false);
                  return;
                }

                // 处理致命错误
                if (data.fatal) {
                  switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                      networkRetryCount.current++;
                      
                      if (networkRetryCount.current > MAX_NETWORK_RETRY) {
                        const errorMsg = data.response?.code === 404
                          ? '视频资源不存在（404）'
                          : '网络连接失败，请检查网络连接';
                        setPlayerError('network', errorMsg, true);
                        hls.stopLoad();
                      } else {
                        setTimeout(() => {
                          if (isMountedRef.current) {
                            hls.startLoad();
                          }
                        }, 1000 * networkRetryCount.current);
                      }
                      break;

                    case Hls.ErrorTypes.MEDIA_ERROR:
                      mediaRetryCount.current++;
                      
                      if (mediaRetryCount.current > MAX_MEDIA_RETRY) {
                        setPlayerError('media', '视频格式错误或编码不支持', false);
                        hls.stopLoad();
                      } else {
                        setTimeout(() => {
                          if (isMountedRef.current) {
                            hls.recoverMediaError();
                          }
                        }, 500);
                      }
                      break;

                    default:
                      setPlayerError('unknown', `视频加载失败: ${data.details || '未知错误'}`, true);
                      break;
                  }
                }
              });
            },
          },
          // 设置面板
          settings: [
            {
              name: 'playbackRate',
              html: '播放速度',
              selector: [
                { html: '0.5x', value: 0.5 },
                { html: '0.75x', value: 0.75 },
                { html: '正常', value: 1, default: true },
                { html: '1.25x', value: 1.25 },
                { html: '1.5x', value: 1.5 },
                { html: '2x', value: 2 },
              ],
              onSelect: function(item) {
                if (art && 'value' in item && typeof item.value === 'number') {
                  art.playbackRate = item.value;
                }
              },
            },
          ],
        });

        artRef.current = art;

        // 监听播放事件
        art.on('ready', () => {
          setIsLoading(false);
        });

        art.on('video:loadedmetadata', () => {
          // 恢复播放进度
          if (settings.autoSaveProgress) {
            const savedProgress = localStorage.getItem(`video_progress_${videoUrl}`);
            if (savedProgress) {
              try {
                const progress = JSON.parse(savedProgress);
                if (progress.time > 10 && progress.time < art.duration - 10) {
                  art.currentTime = progress.time;
                }
              } catch (e) {
                if (process.env.NODE_ENV === 'development') {
                  console.log('[Progress Restore Failed]', e);
                }
              }
            }
          }
        });

        // 播放进度更新
        art.on('video:timeupdate', () => {
          const currentTime = art.currentTime;
          onProgress?.(currentTime);

          // 自动保存播放进度
          if (settings.autoSaveProgress && Math.floor(currentTime) % settings.progressSaveInterval === 0) {
            localStorage.setItem(
              `video_progress_${videoUrl}`,
              JSON.stringify({
                time: currentTime,
                timestamp: Date.now(),
              })
            );
          }
        });

        // 播放结束
        art.on('video:ended', () => {
          // 清除播放进度
          if (settings.autoSaveProgress) {
            localStorage.removeItem(`video_progress_${videoUrl}`);
          }
          
          onEnded?.();
        });

        // 播放错误
        art.on('video:error', (err: Error) => {
          console.log('[Video Error]', err);
          setPlayerError('media', '视频播放失败', false);
        });

      } catch (err) {
        console.log('[Player Init Failed]', err);
        setPlayerError('unknown', '播放器加载失败，请刷新重试', true);
      }
    };

    initPlayer();

    // 清理函数
    return () => {
      isMountedRef.current = false;
      
      if (artRef.current) {
        try {
          artRef.current.destroy();
        } catch {
          // 静默处理清理错误
        }
        artRef.current = null;
      }
      
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
          // 静默处理清理错误
        }
        hlsRef.current = null;
      }
    };
  }, [isClient, videoUrl, title, settings, getProxiedUrl, onProgress, onEnded, onError, setPlayerError, retryCount]);

  if (!isClient) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-white">初始化播放器...</div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black">
      {/* 播放器容器 */}
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ aspectRatio: '16/9' }}
      />

      {/* Loading状态 */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-150 pointer-events-none">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-700 border-t-red-600 mx-auto mb-4" />
            <p className="text-white text-lg">加载播放器中...</p>
          </div>
        </div>
      )}

      {/* 错误状态 */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/95 z-50">
          <div className="text-center px-6 max-w-md">
            <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-10 h-10 text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            
            <h3 className="text-white text-xl font-semibold mb-2">
              {error.type === 'network' && '网络错误'}
              {error.type === 'media' && '媒体错误'}
              {error.type === 'key' && '加密密钥错误'}
              {error.type === 'manifest' && '清单加载失败'}
              {error.type === 'fragment' && '视频片段错误'}
              {error.type === 'unknown' && '播放失败'}
            </h3>
            
            <p className="text-gray-300 text-base mb-6">{error.message}</p>
            
            <div className="flex gap-3 justify-center">
              {error.canRetry && (
                <button
                  onClick={handleRetry}
                  className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors font-medium"
                >
                  重新加载
                </button>
              )}
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors font-medium"
              >
                刷新页面
              </button>
            </div>
            
            {retryCount > 0 && (
              <p className="text-gray-500 text-sm mt-4">
                已重试 {retryCount} 次
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
