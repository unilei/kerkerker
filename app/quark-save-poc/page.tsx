"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Clapperboard, Copy, LogOut, Play, RefreshCw, Send } from "lucide-react";

/**
 * 夸克自助转存 + 试播 PoC 测试页（/quark-save-poc）
 *
 * 完整流程实测：扫码登录（或粘贴 cookie 兜底）→ 凭证落库 →
 * 选剧（或粘贴 dramaId）→ 转存到访客自己的夸克网盘默认「来自：分享」目录 →
 * 列出剧集文件 → 取直链在浏览器里裸播（验证直链是否校验 Referer/UA）。
 * 仅用于 PoC 验证，验收后再决定是否做进详情页与播放层。
 */

const API = "/api/play/quark";

interface QrStart {
  token: string;
  requestId: string;
  qrText: string;
  expiresInMs: number;
}

interface DramaCard {
  id: string;
  title: string;
  episode_count?: number;
  cover_url?: string;
}

interface EpisodeFile {
  fid: string;
  name: string;
  size: number | null;
}

interface LogEntry {
  time: string;
  kind: "info" | "ok" | "warn" | "error";
  text: string;
}

/** 字节数 → 可读大小（直链清单展示用） */
function formatSize(size: number | null): string {
  if (size === null || size <= 0) return "";
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(size / 1024)} KB`;
}

export default function QuarkSavePocPage() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [nickname, setNickname] = useState<string | undefined>();
  const [checking, setChecking] = useState(true);
  const [qr, setQr] = useState<QrStart | null>(null);
  const [qrCountdown, setQrCountdown] = useState(0);
  const [qrError, setQrError] = useState<string | null>(null);
  const [cookieInput, setCookieInput] = useState("");
  const [dramas, setDramas] = useState<DramaCard[]>([]);
  const [dramaIdInput, setDramaIdInput] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [files, setFiles] = useState<EpisodeFile[]>([]);
  const [filesDramaTitle, setFilesDramaTitle] = useState("");
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [playingFid, setPlayingFid] = useState<string | null>(null);
  const [playInfo, setPlayInfo] = useState<{
    fid: string;
    url: string;
    kind: "mp4" | "m3u8";
  } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = useCallback((kind: LogEntry["kind"], text: string) => {
    setLogs((prev) =>
      [
        {
          time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          kind,
          text,
        },
        ...prev,
      ].slice(0, 30)
    );
  }, []);

  const fetchStatus = useCallback(async () => {
    const payload = await (await fetch(`${API}?action=status`, { cache: "no-store" })).json();
    setLoggedIn(!!payload.data?.logged_in);
    setNickname(payload.data?.nickname || undefined);
    setChecking(false);
    return !!payload.data?.logged_in;
  }, []);

  const loadDramas = useCallback(async () => {
    try {
      const payload = await (
        await fetch("/api/short-dramas?page=1&limit=12", { cache: "no-store" })
      ).json();
      setDramas(payload.data?.dramas || []);
    } catch {
      addLog("error", "短剧列表读取失败");
    }
  }, [addLog]);

  const stopQrTimers = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    pollTimerRef.current = null;
    countdownTimerRef.current = null;
  }, []);

  const startQrLogin = useCallback(async () => {
    stopQrTimers();
    setQrError(null);
    setQr(null);
    try {
      const payload = await (await fetch(`${API}?action=qr_start`, { cache: "no-store" })).json();
      if (payload.code !== 200 || !payload.data?.qrText) {
        setQrError(payload.message || "二维码获取失败");
        return;
      }
      const qrStart: QrStart = payload.data;
      setQr(qrStart);
      setQrCountdown(Math.floor(qrStart.expiresInMs / 1000));
      addLog("info", "二维码已生成，请用夸克 App 扫码");

      countdownTimerRef.current = setInterval(() => {
        setQrCountdown((prev) => {
          if (prev <= 1) {
            stopQrTimers();
            setQr(null);
            setQrError("二维码已过期，请点击刷新重新获取");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      pollTimerRef.current = setInterval(async () => {
        try {
          const poll = await (
            await fetch(
              `${API}?action=qr_poll&token=${encodeURIComponent(qrStart.token)}`,
              { cache: "no-store" }
            )
          ).json();
          if (poll.data?.status === "ok") {
            stopQrTimers();
            setQr(null);
            addLog("ok", `扫码登录成功：${poll.data.nickname || "夸克用户"}`);
            await fetchStatus();
          } else if (poll.data?.status === "expired") {
            // 夸克侧判定二维码失效：立即换新码（无需用户手点）
            stopQrTimers();
            addLog("warn", `二维码已失效（${poll.data.message || "expired"}），自动刷新`);
            startQrLogin();
          }
        } catch {
          // 轮询失败下次重试
        }
      }, 2000);
    } catch (error) {
      setQrError(error instanceof Error ? error.message : "二维码获取失败");
    }
  }, [addLog, fetchStatus, stopQrTimers]);

  useEffect(() => {
    fetchStatus().then((loggedInNow) => {
      if (!loggedInNow) startQrLogin();
      loadDramas();
    });
    return stopQrTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cookieLogin = async () => {
    setQrError(null);
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cookie_login", cookie: cookieInput }),
      });
      const payload = await response.json();
      if (payload.code === 200) {
        setCookieInput("");
        addLog("ok", `Cookie 登录成功：${payload.data?.nickname || "夸克用户"}`);
        stopQrTimers();
        setQr(null);
        await fetchStatus();
      } else {
        addLog("error", payload.message || "Cookie 登录失败");
      }
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : "网络异常");
    }
  };

  const logout = async () => {
    await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    addLog("info", "已退出登录");
    setFiles([]);
    setFilesDramaTitle("");
    setPlayInfo(null);
    await fetchStatus();
    startQrLogin();
  };

  const saveDrama = async (dramaId: string) => {
    if (!dramaId) return;
    setSavingId(dramaId);
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", dramaId }),
      });
      const payload = await response.json();
      if (payload.code === 200) {
        addLog(
          payload.data?.warning ? "warn" : "ok",
          `《${payload.data?.title || dramaId}》转存成功（${payload.data?.saved} 个条目）→ 已存入你网盘「来自：分享」目录${
            payload.data?.warning ? `；提示：${payload.data.warning}` : ""
          }`
        );
      } else {
        addLog("error", `转存失败：${payload.message || "未知错误"}`);
      }
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : "网络异常");
    } finally {
      setSavingId(null);
    }
  };

  /** 列出某剧在访客网盘里的视频文件（需先转存） */
  const loadFiles = async (dramaId: string, title: string) => {
    if (!dramaId) return;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const response = await fetch(
        `${API}?action=files&dramaId=${encodeURIComponent(dramaId)}`,
        { cache: "no-store" }
      );
      const payload = await response.json();
      if (response.status === 401) {
        setFilesError("登录已失效，请重新扫码登录");
        addLog("warn", "登录已失效，请重新扫码登录");
        await fetchStatus();
        startQrLogin();
        return;
      }
      if (payload.code === 200) {
        const list: EpisodeFile[] = payload.data?.files || [];
        setFiles(list);
        setFilesDramaTitle(payload.data?.title || title);
        addLog("ok", `《${payload.data?.title || title}》找到 ${list.length} 个视频文件`);
      } else {
        setFiles([]);
        setFilesDramaTitle("");
        setFilesError(payload.message || "剧集文件读取失败");
        addLog("error", payload.message || "剧集文件读取失败");
      }
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : "网络异常");
      addLog("error", error instanceof Error ? error.message : "网络异常");
    } finally {
      setFilesLoading(false);
    }
  };

  /** 取某文件播放直链并交给 <video> 裸播（PoC 的关键验证点） */
  const playFile = async (file: EpisodeFile) => {
    setPlayingFid(file.fid);
    try {
      const response = await fetch(
        `${API}?action=play&fid=${encodeURIComponent(file.fid)}`,
        { cache: "no-store" }
      );
      const payload = await response.json();
      if (response.status === 401) {
        addLog("warn", "登录已失效，请重新扫码登录");
        await fetchStatus();
        startQrLogin();
        return;
      }
      if (payload.code === 200 && payload.data?.playUrl) {
        const info = {
          fid: file.fid,
          url: payload.data.playUrl as string,
          kind: payload.data.kind as "mp4" | "m3u8",
        };
        setPlayInfo(info);
        addLog(
          info.kind === "mp4" ? "ok" : "warn",
          `直链已获取（${info.kind === "mp4" ? "原画 mp4" : `转码 m3u8/${payload.data.resolution || "?"}`}），经服务端代理播放`
        );
      } else {
        addLog("error", payload.message || "直链获取失败");
      }
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : "网络异常");
    } finally {
      setPlayingFid(null);
    }
  };

  const copyPlayUrl = async () => {
    if (!playInfo) return;
    try {
      await navigator.clipboard.writeText(playInfo.url);
      addLog("info", "直链已复制到剪贴板");
    } catch {
      addLog("error", "复制失败（浏览器限制了剪贴板权限）");
    }
  };

  // 直链变化时加载并自动起播
  useEffect(() => {
    if (!playInfo || !videoRef.current) return;
    videoRef.current.load();
    videoRef.current.play().catch(() => {
      // 自动播放可能被浏览器策略拦截，交给用户手点
    });
  }, [playInfo]);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-gray-200 px-4 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="flex items-center gap-3">
          <Clapperboard size={22} className="text-amber-400" />
          <h1 className="text-white font-bold text-xl">
            夸克自助转存 PoC
          </h1>
          <span className="text-xs text-gray-600">
            扫码登录 → 转存到访客自己网盘 → 试播直链
          </span>
        </header>

        {/* 登录区 */}
        <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
          {checking ? (
            <p className="text-sm text-gray-500">正在检查登录状态…</p>
          ) : loggedIn ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-green-400 font-medium">
                已登录：{nickname || "夸克用户"}
              </span>
              <button
                onClick={logout}
                className="px-3 py-1.5 bg-[#2a2a2a] hover:bg-[#333] text-gray-300 rounded-lg text-sm flex items-center gap-1.5 transition-colors"
              >
                <LogOut size={14} />
                退出登录
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-8 items-start">
              <div className="text-center">
                {qr ? (
                  <>
                    <div className="bg-white p-3 rounded-lg inline-block">
                      <QRCodeSVG value={qr.qrText} size={168} />
                    </div>
                    <p className="mt-2 text-xs text-gray-500">
                      夸克 App 扫码登录（{qrCountdown}s 后过期）
                    </p>
                  </>
                ) : (
                  <div className="w-[192px] h-[192px] border border-dashed border-[#444] rounded-lg flex items-center justify-center">
                    <button
                      onClick={startQrLogin}
                      className="px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm flex items-center gap-2 transition-colors"
                    >
                      <RefreshCw size={14} />
                      {qrError ? "重新获取二维码" : "获取二维码"}
                    </button>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-[260px] space-y-2">
                <p className="text-sm text-gray-400">扫码失败？粘贴 cookie 兜底：</p>
                <textarea
                  value={cookieInput}
                  onChange={(event) => setCookieInput(event.target.value)}
                  rows={3}
                  placeholder="__kps=…; __pus=…; __puus=…（浏览器登录 pan.quark.cn 后复制整行 cookie）"
                  className="w-full bg-black/40 border border-[#333] rounded-lg px-3 py-2 text-xs text-gray-200 font-mono placeholder:text-gray-600 focus:outline-none focus:border-red-600"
                />
                <button
                  onClick={cookieLogin}
                  disabled={!cookieInput.trim()}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Cookie 登录
                </button>
              </div>
            </div>
          )}
          {qrError && <p className="mt-3 text-xs text-yellow-400/90">{qrError}</p>}
        </section>

        {/* 选剧 + 转存 */}
        <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
          <h2 className="text-white font-bold mb-1">选一部剧转存</h2>
          <p className="text-xs text-gray-600 mb-4">
            使用<strong className="text-gray-400">你自己的</strong>
            夸克账号容量转存（存进「来自：分享」目录），不占用站方网盘
          </p>
          <div className="flex flex-wrap gap-3 mb-4">
            <input
              value={dramaIdInput}
              onChange={(event) => setDramaIdInput(event.target.value)}
              placeholder="或粘贴 dramaId（Mongo 24 位 hex，可从管理后台待转存列表拿）"
              className="flex-1 min-w-[280px] bg-black/40 border border-[#333] rounded-lg px-3 py-2 text-sm text-gray-200 font-mono placeholder:text-gray-600 focus:outline-none focus:border-sky-500"
            />
            <button
              onClick={() => saveDrama(dramaIdInput.trim())}
              disabled={!dramaIdInput.trim() || savingId !== null || !loggedIn}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
            >
              <Send size={14} />
              转存该剧
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {dramas.map((drama) => (
              <div
                key={drama.id}
                className="bg-black/30 border border-[#2a2a2a] rounded-lg overflow-hidden group"
              >
                <div className="relative aspect-[3/4] bg-[#222]">
                  {drama.cover_url ? (
                    <img
                      src={drama.cover_url}
                      alt={drama.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-700 text-xs">
                      无封面
                    </div>
                  )}
                  <button
                    onClick={() => saveDrama(drama.id)}
                    disabled={!loggedIn || savingId !== null}
                    className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 disabled:opacity-0 transition-opacity flex items-center justify-center"
                  >
                    <span className="px-3 py-1.5 bg-sky-600 rounded text-white text-xs font-medium flex items-center gap-1">
                      <Send size={12} />
                      {savingId === drama.id ? "转存中…" : "转存"}
                    </span>
                  </button>
                </div>
                <div className="px-2 py-1.5 flex items-center justify-between gap-1">
                  <p className="text-xs text-gray-300 truncate" title={drama.title}>
                    {drama.title}
                    {drama.episode_count ? `（${drama.episode_count}集）` : ""}
                  </p>
                  <button
                    onClick={() => loadFiles(drama.id, drama.title)}
                    disabled={!loggedIn || filesLoading}
                    title="列出网盘里的剧集并试播"
                    className="shrink-0 px-1.5 py-1 bg-[#2a2a2a] hover:bg-[#3a3a3a] disabled:opacity-40 text-gray-300 rounded text-[10px] flex items-center gap-1 transition-colors"
                  >
                    <Play size={10} />
                    {filesLoading ? "加载中…" : "试播"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {dramas.length === 0 && (
            <p className="text-sm text-gray-600 py-6 text-center">
              还没有转存完成（done）的短剧可展示；可直接粘贴 dramaId 测试。
            </p>
          )}
        </section>

        {/* 试播（播放直链裸测） */}
        <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
          <h2 className="text-white font-bold mb-1">试播</h2>
          <p className="text-xs text-gray-600 mb-4">
            浏览器跨站不带 __puus、直链裸播被 412 拦截（已实测），因此走服务端代理：带你的 cookie 取直链并流式转发，支持拖进度条
          </p>
          {files.length === 0 ? (
            <p
              className={`text-sm py-4 text-center ${
                filesError ? "text-yellow-400/90" : "text-gray-600"
              }`}
            >
              {filesLoading
                ? "正在读取网盘文件…"
                : filesError
                  ? filesError
                  : "点上面卡片上的「试播」按钮，列出你网盘里该剧的剧集文件"}
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-300">
                《{filesDramaTitle || "未命名"}》· {files.length} 个文件
              </p>
              {playInfo?.kind === "m3u8" && (
                <p className="text-xs text-yellow-400/90">
                  当前是转码 m3u8 流：代理未转发分片，可能无法播放——换其他集（原画 mp4）测试
                </p>
              )}
              <div className="bg-black rounded-lg overflow-hidden">
                {playInfo ? (
                  <video
                    ref={videoRef}
                    src={`/api/play/quark?action=proxy&fid=${encodeURIComponent(playInfo.fid)}`}
                    controls
                    onError={() => {
                      addLog(
                        "error",
                        "代理播放失败：夸克 CDN 拒绝或会话失效，请重试或重新扫码"
                      );
                    }}
                    onPlaying={() => {
                      addLog(
                        "ok",
                        "代理播放成功！服务端带 cookie 转发可行（Range 已透传，支持拖进度条）"
                      );
                    }}
                    className="w-full aspect-video"
                  />
                ) : (
                  <div className="aspect-video flex items-center justify-center text-gray-700 text-sm">
                    点下面任意一集开始播放
                  </div>
                )}
              </div>
              {playInfo && (
                <button
                  onClick={copyPlayUrl}
                  className="px-3 py-1.5 bg-[#2a2a2a] hover:bg-[#333] text-gray-300 rounded-lg text-xs flex items-center gap-1.5 transition-colors"
                >
                  <Copy size={12} />
                  复制原始直链
                </button>
              )}
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto">
                {files.map((file) => (
                  <li key={file.fid}>
                    <button
                      onClick={() => playFile(file)}
                      disabled={playingFid !== null}
                      className="w-full text-left px-3 py-2 bg-black/30 border border-[#2a2a2a] hover:border-amber-500/60 disabled:opacity-50 rounded-lg text-xs text-gray-300 flex items-center justify-between gap-2 transition-colors"
                    >
                      <span className="truncate" title={file.name}>
                        {file.name}
                      </span>
                      <span className="shrink-0 text-gray-600 font-mono">
                        {playingFid === file.fid ? "取直链…" : formatSize(file.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* 操作日志 */}
        <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
          <h2 className="text-white font-bold mb-3">操作日志</h2>
          {logs.length === 0 ? (
            <p className="text-sm text-gray-600">暂无操作</p>
          ) : (
            <ul className="space-y-1.5 font-mono text-xs">
              {logs.map((log, index) => (
                <li key={`${log.time}-${index}`} className="flex gap-3">
                  <span className="text-gray-600 shrink-0">{log.time}</span>
                  <span
                    className={
                      log.kind === "ok"
                        ? "text-green-400"
                        : log.kind === "warn"
                          ? "text-yellow-400/90"
                          : log.kind === "error"
                            ? "text-red-400"
                            : "text-gray-400"
                    }
                  >
                    {log.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
