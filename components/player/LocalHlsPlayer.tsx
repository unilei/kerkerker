"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type Artplayer from "artplayer";
import type HlsType from "hls.js";
import { LocalPlayerSettings } from "@/app/api/player-config/route";

// 导入拆分的模块
import type { PlayerError, ErrorType, HlsErrorData } from "@/lib/player/types";
import { checkCorsSupport } from "@/lib/player/cors-check";
import { createHlsConfig } from "@/lib/player/hls-config";
import { PlayerLoading } from "./PlayerLoading";
import { PlayerErrorDisplay } from "./PlayerError";

interface LocalHlsPlayerProps {
  videoUrl: string;
  title: string;
  settings: LocalPlayerSettings;
  onProgress?: (time: number) => void;
  onEnded?: () => void;
  onError?: () => void;
}

// 常量
const MAX_NETWORK_RETRY = 3;
const MAX_MEDIA_RETRY = 2;
const MAX_KEY_ERROR = 5;

export function LocalHlsPlayer({
  videoUrl,
  title: _title, // eslint-disable-line @typescript-eslint/no-unused-vars
  settings,
  onProgress,
  onEnded,
  onError,
}: LocalHlsPlayerProps) {
  // 状态
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<PlayerError | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [useDirectPlay, setUseDirectPlay] = useState(true);
  const [, setPlayMode] = useState<"direct" | "proxy" | "detecting">(
    "detecting"
  );

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<Artplayer | null>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const networkRetryCount = useRef<number>(0);
  const mediaRetryCount = useRef<number>(0);
  const keyErrorCount = useRef<number>(0);
  const timersRef = useRef<Set<NodeJS.Timeout>>(new Set());

  // 回调 refs
  const onProgressRef = useRef(onProgress);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const settingsRef = useRef(settings);

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
  const getProxiedUrl = useCallback(
    (url: string) => {
      if (!url) return "";
      if (url.startsWith("/api/video-proxy/")) return url;
      if (useDirectPlay) return url;
      return `/api/video-proxy/${encodeURIComponent(url)}`;
    },
    [useDirectPlay]
  );

  // 设置错误状态
  const setPlayerError = useCallback(
    (type: ErrorType, message: string, canRetry: boolean = false) => {
      if (!isMountedRef.current) return;
      setError({ type, message, canRetry });
      setIsLoading(false);
      if (!canRetry) {
        onErrorRef.current?.();
      }
    },
    []
  );

  // 重试播放
  const handleRetry = useCallback(() => {
    setError(null);
    setIsLoading(true);
    setRetryCount((prev) => prev + 1);
    networkRetryCount.current = 0;
    mediaRetryCount.current = 0;
    keyErrorCount.current = 0;
  }, []);

  // 清理播放器实例
  const cleanupPlayer = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();

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
        const videoElement = artRef.current.video;
        artRef.current.destroy();
        if (videoElement) {
          videoElement.pause();
          videoElement.src = "";
          videoElement.load();
          videoElement.removeAttribute("src");
        }
      } catch {
        // 忽略清理错误
      }
      artRef.current = null;
    }
  }, []);

  // 初始化播放器
  useEffect(() => {
    if (!isClient || !containerRef.current || !videoUrl) return;

    // 重置挂载状态（effect 重新执行时）
    isMountedRef.current = true;

    const initPlayer = async () => {
      try {
        setPlayMode(useDirectPlay ? "direct" : "proxy");
        console.log(
          `🎬 开始播放: ${useDirectPlay ? "⚡直接播放模式" : "🔄代理模式"}`
        );

        // CORS 检测
        if (useDirectPlay) {
          console.log("🔍 检测视频源 CORS 支持...");
          const corsResult = await checkCorsSupport(videoUrl);

          if (!isMountedRef.current) return;

          if (!corsResult.success) {
            if (corsResult.reason === "cors") {
              console.log("⚠️ CORS 不支持，切换到代理模式");
              setUseDirectPlay(false);
              setPlayMode("proxy");
              setRetryCount((prev) => prev + 1);
              return;
            } else if (corsResult.reason === "expired") {
              console.log(
                `⚠️ 视频源返回 HTTP ${corsResult.code}，可能是链接过期`
              );
            } else {
              console.log("⚠️ 网络检测失败，继续尝试播放...");
            }
          } else {
            console.log("✅ CORS 支持，继续直接播放");
          }
        }

        // 动态导入
        const [ArtplayerModule, HlsModule] = await Promise.all([
          import("artplayer"),
          import("hls.js"),
        ]);

        if (!isMountedRef.current || !containerRef.current) {
          console.log("⚠️ 组件已卸载或容器不存在，取消初始化");
          return;
        }

        const Artplayer = ArtplayerModule.default;
        const Hls = HlsModule.default;

        // 清理旧实例
        cleanupPlayer();

        // 创建 HLS 配置
        const hlsConfig = createHlsConfig(Hls);

        // 创建 ArtPlayer 实例
        const art = new Artplayer({
          container: containerRef.current,
          url: getProxiedUrl(videoUrl),
          type: "m3u8",
          volume: 0.8,
          isLive: false,
          muted: false,
          autoplay: false,
          pip: true,
          autoSize: false,
          autoMini: true,
          screenshot: true,
          setting: true,
          loop: true,
          flip: true,
          playbackRate: true,
          aspectRatio: true,
          fullscreen: true,
          fullscreenWeb: true,
          subtitleOffset: true,
          miniProgressBar: true,
          mutex: true,
          backdrop: true,
          playsInline: true,
          autoPlayback: true,
          airplay: true,
          theme: settingsRef.current.theme || "#ef4444",
          lang: navigator.language.toLowerCase(),
          lock: true,
          fastForward: true,
          autoOrientation: true,
          moreVideoAttr: {
            crossOrigin: "anonymous",
          },
          customType: {
            m3u8: (video: HTMLVideoElement, url: string) => {
              if (!isMountedRef.current) return;

              const hls = new Hls(hlsConfig);
              hlsRef.current = hls;

              hls.loadSource(url);
              hls.attachMedia(video);

              // Manifest 加载完成
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                if (isMountedRef.current && video && document.contains(video)) {
                  video.play().catch((e) => {
                    if (e.name === "NotAllowedError") {
                      console.log("⏸️ 自动播放被阻止，请点击播放按钮开始播放");
                    } else if (
                      e.name !== "AbortError" &&
                      process.env.NODE_ENV === "development"
                    ) {
                      console.log("[Autoplay Failed]", e);
                    }
                  });
                }
              });

              // 错误处理
              hls.on(
                Hls.Events.ERROR,
                async (_event: string, data: HlsErrorData) => {
                  handleHlsError(
                    data,
                    hls,
                    Hls,
                    useDirectPlay,
                    setUseDirectPlay,
                    setPlayMode,
                    setRetryCount,
                    setPlayerError
                  );
                }
              );
            },
          },
          settings: [
            {
              name: "playbackRate",
              html: "播放速度",
              selector: [
                { html: "0.5x", value: 0.5 },
                { html: "0.75x", value: 0.75 },
                { html: "正常", value: 1, default: true },
                { html: "1.25x", value: 1.25 },
                { html: "1.5x", value: 1.5 },
                { html: "2x", value: 2 },
              ],
              onSelect: function (item) {
                if (art && "value" in item && typeof item.value === "number") {
                  art.playbackRate = item.value;
                }
              },
            },
          ],
        });

        artRef.current = art;

        // 事件监听
        art.on("ready", () => setIsLoading(false));

        art.on("video:loadedmetadata", () => {
          if (settingsRef.current.autoSaveProgress) {
            const saved = localStorage.getItem(`video_progress_${videoUrl}`);
            if (saved) {
              try {
                const progress = JSON.parse(saved);
                if (progress.time > 10 && progress.time < art.duration - 10) {
                  art.currentTime = progress.time;
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        });

        art.on("video:timeupdate", () => {
          const currentTime = art.currentTime;
          onProgressRef.current?.(currentTime);

          const currentSettings = settingsRef.current;
          if (
            currentSettings.autoSaveProgress &&
            Math.floor(currentTime) % currentSettings.progressSaveInterval === 0
          ) {
            localStorage.setItem(
              `video_progress_${videoUrl}`,
              JSON.stringify({ time: currentTime, timestamp: Date.now() })
            );
          }
        });

        art.on("video:ended", () => {
          if (settingsRef.current.autoSaveProgress) {
            localStorage.removeItem(`video_progress_${videoUrl}`);
          }
          onEndedRef.current?.();
        });

        art.on("video:error", (err: Error) => {
          console.log("[Video Error]", err);
          setPlayerError("media", "视频播放失败", false);
        });
      } catch (err) {
        console.log("[Player Init Failed]", err);
        setPlayerError("unknown", "播放器加载失败，请刷新重试", true);
      }
    };

    initPlayer();

    return () => {
      isMountedRef.current = false;
      cleanupPlayer();
    };
  }, [
    isClient,
    videoUrl,
    retryCount,
    useDirectPlay,
    getProxiedUrl,
    setPlayerError,
    cleanupPlayer,
  ]);

  // HLS 错误处理函数
  function handleHlsError(
    data: HlsErrorData,
    hls: HlsType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Hls: any,
    useDirectPlay: boolean,
    setUseDirectPlay: (v: boolean) => void,
    setPlayMode: (v: "direct" | "proxy" | "detecting") => void,
    setRetryCount: (fn: (prev: number) => number) => void,
    setPlayerError: (
      type: ErrorType,
      message: string,
      canRetry: boolean
    ) => void
  ) {
    // 密钥错误
    if (data.details === "keyLoadError" || data.details === "keyLoadTimeOut") {
      keyErrorCount.current++;
      if (keyErrorCount.current > MAX_KEY_ERROR) {
        const errorMsg =
          data.response?.code === 404
            ? "视频加密密钥不存在（404），无法播放此视频"
            : "视频加密密钥加载失败，无法播放";
        setPlayerError("key", errorMsg, false);
        hls.stopLoad();
      }
      return;
    }

    // 清单错误
    if (data.details === "manifestLoadError") {
      const is404 = data.response?.code === 404;
      const is403 = data.response?.code === 403;
      const statusCode = data.response?.code;

      if (useDirectPlay && !is404 && !is403 && !statusCode) {
        console.log("🔄 直接播放失败（可能是CORS），切换到代理模式...");
        setUseDirectPlay(false);
        setPlayMode("proxy");
        setRetryCount((prev) => prev + 1);
        return;
      }

      let errorMsg: string;
      let canRetry = false;

      if (is404) {
        errorMsg = "视频文件不存在（404）";
      } else if (is403) {
        errorMsg = "视频链接已过期或无效（403），请返回重新选择";
      } else if (statusCode) {
        errorMsg = `视频清单加载失败 (HTTP ${statusCode})`;
        canRetry = true;
      } else {
        errorMsg = "视频清单加载失败，请检查网络连接";
        canRetry = true;
      }

      setPlayerError("manifest", errorMsg, canRetry);
      return;
    }

    // 片段错误
    if (data.details === "fragLoadError" && data.response?.code === 404) {
      setPlayerError(
        "fragment",
        "视频片段不存在（404），该视频可能已损坏",
        false
      );
      return;
    }

    // 致命错误
    if (data.fatal) {
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          networkRetryCount.current++;
          if (networkRetryCount.current > MAX_NETWORK_RETRY) {
            const errorMsg =
              data.response?.code === 404
                ? "视频资源不存在（404）"
                : "网络连接失败，请检查网络连接";
            setPlayerError("network", errorMsg, true);
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
            setPlayerError("media", "视频格式错误或编码不支持", false);
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
          setPlayerError(
            "unknown",
            `视频加载失败: ${data.details || "未知错误"}`,
            true
          );
          break;
      }
    }
  }

  if (!isClient) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-white">初始化播放器...</div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black">
      <div ref={containerRef} className="w-full h-full" />
      {isLoading && <PlayerLoading />}
      {error && (
        <PlayerErrorDisplay
          error={error}
          retryCount={retryCount}
          onRetry={handleRetry}
          onReload={() => window.location.reload()}
        />
      )}
    </div>
  );
}
