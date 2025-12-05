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
  title: _title, // eslint-disable-line @typescript-eslint/no-unused-vars
  settings,
  onProgress,
  onEnded,
  onError,
}: LocalHlsPlayerProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<PlayerError | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [useDirectPlay, setUseDirectPlay] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<Artplayer | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const networkRetryCount = useRef<number>(0);
  const mediaRetryCount = useRef<number>(0);
  const keyErrorCount = useRef<number>(0);
  const timersRef = useRef<Set<NodeJS.Timeout>>(new Set()); // 存储所有定时器
  
  // 使用 ref 保存回调，避免 useEffect 依赖变化导致频繁重建
  const onProgressRef = useRef(onProgress);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const settingsRef = useRef(settings);
  
  const MAX_NETWORK_RETRY = 3;
  const MAX_MEDIA_RETRY = 2;
  const MAX_KEY_ERROR = 5; // 密钥错误最多容忍5次

  // 更新回调 ref
  useEffect(() => {
    onProgressRef.current = onProgress;
    onEndedRef.current = onEnded;
    onErrorRef.current = onError;
    settingsRef.current = settings;
  });

  // 确保在客户端执行
  useEffect(() => {
    setIsClient(true);
  }, []);

  // 获取代理后的URL
  const getProxiedUrl = useCallback((url: string) => {
    if (!url) return '';
    if (url.startsWith('/api/video-proxy/')) return url;
    // 如果启用了直接播放模式，直接返回原始URL
    if (useDirectPlay) return url;
    return `/api/video-proxy/${encodeURIComponent(url)}`;
  }, [useDirectPlay]);

  // 设置错误状态
  const setPlayerError = useCallback((type: ErrorType, message: string, canRetry: boolean = false) => {
    if (!isMountedRef.current) return;
    setError({ type, message, canRetry });
    setIsLoading(false);
    
    if (!canRetry) {
      onErrorRef.current?.();
    }
  }, []);

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

        // 清理旧实例（先停止加载）
        if (hlsRef.current) {
          try {
            hlsRef.current.stopLoad();
            hlsRef.current.detachMedia();
            hlsRef.current.destroy();
          } catch {
            // 忽略清理错误
          }
          hlsRef.current = null;
        }

        if (artRef.current) {
          try {
            if (artRef.current.video) {
              artRef.current.video.pause();
              artRef.current.video.src = '';
              artRef.current.video.load();
            }
            artRef.current.destroy();
          } catch {
            // 忽略清理错误
          }
          artRef.current = null;
        }

        // 清理所有定时器
        timersRef.current.forEach(timer => clearTimeout(timer));
        timersRef.current.clear();

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
          theme: settingsRef.current.theme || '#ef4444',
          lang: 'zh-cn',
          moreVideoAttr: {
            crossOrigin: 'anonymous',
          },
          customType: {
            m3u8: (video: HTMLVideoElement, url: string) => {
              // 检查组件是否已卸载
              if (!isMountedRef.current) {
                return;
              }

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
              hls.on(Hls.Events.ERROR, async (_event: string, data: HlsErrorData) => {
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
                  const is403 = data.response?.code === 403;
                  
                  // 如果是403且还未尝试直接播放，尝试fallback
                  if (is403 && !useDirectPlay) {
                    console.log('🔄 代理被封锁，尝试直接播放模式...');
                    setUseDirectPlay(true);
                    setRetryCount(prev => prev + 1);
                    return;
                  }
                  
                  const errorMsg = is404 
                    ? '视频文件不存在（404）'
                    : is403
                    ? '无法访问视频源，可能被地域封锁'
                    : `视频清单加载失败${data.response?.code ? ` (${data.response.code})` : ''}`;
                  setPlayerError('manifest', errorMsg, !is404 && !is403);
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
                        const timer = setTimeout(() => {
                          if (isMountedRef.current && hlsRef.current) {
                            hls.startLoad();
                          }
                          timersRef.current.delete(timer);
                        }, 1000 * networkRetryCount.current);
                        timersRef.current.add(timer);
                      }
                      break;

                    case Hls.ErrorTypes.MEDIA_ERROR:
                      mediaRetryCount.current++;
                      
                      if (mediaRetryCount.current > MAX_MEDIA_RETRY) {
                        setPlayerError('media', '视频格式错误或编码不支持', false);
                        hls.stopLoad();
                      } else {
                        const timer = setTimeout(() => {
                          if (isMountedRef.current && hlsRef.current) {
                            hls.recoverMediaError();
                          }
                          timersRef.current.delete(timer);
                        }, 500);
                        timersRef.current.add(timer);
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
          if (settingsRef.current.autoSaveProgress) {
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
          onProgressRef.current?.(currentTime);

          // 自动保存播放进度
          const currentSettings = settingsRef.current;
          if (currentSettings.autoSaveProgress && Math.floor(currentTime) % currentSettings.progressSaveInterval === 0) {
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
          if (settingsRef.current.autoSaveProgress) {
            localStorage.removeItem(`video_progress_${videoUrl}`);
          }
          
          onEndedRef.current?.();
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
      
      // 1. 立即清理所有定时器，防止异步操作
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const timers = timersRef.current;
      timers.forEach(timer => clearTimeout(timer));
      timers.clear();
      
      // 2. 先停止 HLS 加载
      if (hlsRef.current) {
        try {
          hlsRef.current.stopLoad();
          hlsRef.current.detachMedia();
        } catch {
          // 忽略错误
        }
      }
      
      // 3. 清理 Artplayer（会自动清理内部资源）
      if (artRef.current) {
        try {
          const videoElement = artRef.current.video;
          // 先销毁 Artplayer
          artRef.current.destroy();
          // 再手动清理 video 元素
          if (videoElement) {
            videoElement.pause();
            videoElement.src = '';
            videoElement.load();
            // 移除所有事件监听器
            videoElement.removeAttribute('src');
          }
        } catch {
          // 忽略错误
        }
        artRef.current = null;
      }
      
      // 4. 最后销毁 HLS 实例
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
          // 忽略错误
        }
        hlsRef.current = null;
      }
    };
  }, [isClient, videoUrl, retryCount, useDirectPlay, getProxiedUrl, setPlayerError]);

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
            {useDirectPlay && (
              <p className="text-yellow-400 text-sm mt-2">正在使用直接播放模式...</p>
            )}
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
