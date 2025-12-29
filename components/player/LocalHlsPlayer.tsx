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

// 弹幕相关导入
import { DanmakuPanel } from "./DanmakuPanel";
import type { DanmakuItem } from "@/lib/player/danmaku-service";
import { autoLoadDanmaku } from "@/lib/player/danmaku-service";
import { MessageSquare, Loader2 } from "lucide-react";

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
  title,
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

  // 弹幕状态
  const [isDanmakuPanelOpen, setIsDanmakuPanelOpen] = useState(false);
  const [danmakuList, setDanmakuList] = useState<DanmakuItem[]>([]);
  const [autoLoadStatus, setAutoLoadStatus] = useState<{
    loading: boolean;
    message: string;
    matchedTitle?: string;
  }>({ loading: false, message: "" });
  const danmakuPluginRef = useRef<ReturnType<
    typeof import("artplayer-plugin-danmuku").default
  > | null>(null);
  const autoLoadAttemptedRef = useRef(false);

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
        const [ArtplayerModule, HlsModule, DanmukuModule] = await Promise.all([
          import("artplayer"),
          import("hls.js"),
          import("artplayer-plugin-danmuku"),
        ]);

        if (!isMountedRef.current || !containerRef.current) {
          console.log("⚠️ 组件已卸载或容器不存在，取消初始化");
          return;
        }

        const Artplayer = ArtplayerModule.default;
        const Hls = HlsModule.default;
        const artplayerPluginDanmuku = DanmukuModule.default;

        // 清理旧实例
        cleanupPlayer();

        // 创建 HLS 配置
        const hlsConfig = createHlsConfig(Hls);

        // 创建弹幕插件实例
        const danmakuPlugin = artplayerPluginDanmuku({
          danmuku: [],
          // 以下为非必填
          speed: 5, // 弹幕持续时间，范围在[1 ~ 10]
          margin: [10, "25%"], // 弹幕上下边距，支持像素数字和百分比
          opacity: 1, // 弹幕透明度，范围在[0 ~ 1]
          color: "#FFFFFF", // 默认弹幕颜色，可以被单独弹幕项覆盖
          mode: 0, // 默认弹幕模式: 0: 滚动，1: 顶部，2: 底部
          modes: [0, 1, 2], // 弹幕可见的模式
          fontSize: 25, // 弹幕字体大小，支持像素数字和百分比
          antiOverlap: true, // 弹幕是否防重叠
          synchronousPlayback: true, // 是否同步播放速度
          mount: undefined, // 弹幕发射器挂载点, 默认为播放器控制栏中部
          heatmap: false, // 是否开启热力图
          width: 512, // 当播放器宽度小于此值时，弹幕发射器置于播放器底部
          points: [], // 热力图数据
          filter: (danmu) => danmu.text.length <= 100, // 弹幕载入前的过滤器
          beforeVisible: () => true, // 弹幕显示前的过滤器，返回 true 则可以发送
          visible: true, // 弹幕层是否可见
          emitter: true, // 是否开启弹幕发射器
          maxLength: 200, // 弹幕输入框最大长度, 范围在[1 ~ 1000]
          lockTime: 5, // 输入框锁定时间，范围在[1 ~ 60]
          theme: "dark", // 弹幕主题，支持 dark 和 light，只在自定义挂载时生效
          OPACITY: {}, // 不透明度配置项
          FONT_SIZE: {}, // 弹幕字号配置项
          MARGIN: {}, // 显示区域配置项
          SPEED: {}, // 弹幕速度配置项
          COLOR: [], // 颜色列表配置项

          // 手动发送弹幕前的过滤器，返回 true 则可以发送
          beforeEmit: () => Promise.resolve(true),
        } as Parameters<typeof artplayerPluginDanmuku>[0]);
        danmakuPluginRef.current = danmakuPlugin;

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
          plugins: [danmakuPlugin],
        });

        artRef.current = art;

        // 事件监听
        art.on("ready", () => {
          setIsLoading(false);

          // 自动加载弹幕
          if (!autoLoadAttemptedRef.current && title) {
            autoLoadAttemptedRef.current = true;
            setAutoLoadStatus({
              loading: true,
              message: "正在自动匹配弹幕...",
            });

            autoLoadDanmaku(title).then((result) => {
              if (result.success && result.danmaku.length > 0) {
                setDanmakuList(result.danmaku);
                setAutoLoadStatus({
                  loading: false,
                  message: result.message,
                  matchedTitle: result.matchedTitle,
                });

                // 加载弹幕到播放器

                const plugin = art.plugins.artplayerPluginDanmuku as any;
                if (plugin) {
                  plugin.config({ danmuku: result.danmaku });
                  plugin.load();
                  console.log(`🎯 自动加载 ${result.danmaku.length} 条弹幕`);
                }

                // 3秒后清除提示
                setTimeout(() => {
                  setAutoLoadStatus({ loading: false, message: "" });
                }, 3000);
              } else {
                setAutoLoadStatus({
                  loading: false,
                  message: result.message,
                });
                // 5秒后清除错误提示
                setTimeout(() => {
                  setAutoLoadStatus({ loading: false, message: "" });
                }, 5000);
              }
            });
          }
        });

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

  // 处理弹幕加载 - 必须在早期返回之前定义以遵守Hooks规则
  const handleDanmakuLoad = useCallback((danmaku: DanmakuItem[]) => {
    setDanmakuList(danmaku);
    if (artRef.current && danmakuPluginRef.current) {
      // 清空现有弹幕并加载新弹幕
      const plugin = artRef.current.plugins.artplayerPluginDanmuku as any;
      if (plugin) {
        plugin.config({ danmuku: danmaku });
        plugin.load();
        console.log(`🎯 已加载 ${danmaku.length} 条弹幕`);
      }
    }
  }, []);

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

      {/* 弹幕手动搜索按钮 - 始终显示，允许用户纠正自动匹配错误 */}
      {!autoLoadStatus.loading && (
        <div className="absolute top-3 right-3 z-40 flex items-center gap-2">
          <button
            onClick={() => setIsDanmakuPanelOpen(true)}
            className="flex items-center gap-2 px-3 py-2 bg-black/60 hover:bg-black/80 rounded-lg transition-colors"
            title="搜索弹幕"
          >
            <MessageSquare size={16} className="text-white" />
            <span className="text-white text-xs">
              {danmakuList.length > 0 ? "换弹幕" : "搜索弹幕"}
            </span>
          </button>
        </div>
      )}

      {/* 自动加载弹幕状态提示 */}
      {autoLoadStatus.loading && autoLoadStatus.message && (
        <div className="absolute top-3 right-3 z-40">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs backdrop-blur-sm border bg-black/70 border-white/20 text-white/90">
            <Loader2 size={12} className="animate-spin text-white/70" />
            <span>{autoLoadStatus.message}</span>
          </div>
        </div>
      )}

      {/* 弹幕搜索面板 */}
      <DanmakuPanel
        videoTitle={title}
        isOpen={isDanmakuPanelOpen}
        onClose={() => setIsDanmakuPanelOpen(false)}
        onDanmakuLoad={handleDanmakuLoad}
      />

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
