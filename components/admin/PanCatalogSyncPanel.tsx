"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  DatabaseZap,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
} from "lucide-react";
import type { ToastState } from "./types";

type TargetStatus = "pending" | "syncing" | "synced" | "empty" | "failed";

interface TargetItem {
  douban_id: string;
  title: string;
  cover?: string;
  year?: string;
  status: TargetStatus;
  attempts: number;
  resources_count: number;
  last_checked_at?: string;
  last_success_at?: string;
  last_error?: string;
}

interface TargetStats {
  total: number;
  pending: number;
  syncing: number;
  synced: number;
  empty: number;
  failed: number;
}

interface TargetResponse {
  items: TargetItem[];
  total: number;
  page: number;
  limit: number;
  stats: TargetStats;
}

interface BatchResponse {
  processed: number;
  synced: number;
  empty: number;
  failed: number;
  imported: number;
  refreshed: number;
  disabled: number;
  remaining: number;
  stats: TargetStats;
}

interface PanCatalogSyncPanelProps {
  onShowToast: (toast: ToastState) => void;
  onSelectMovie: (movie: {
    douban_id: string;
    title: string;
    cover?: string;
    year?: string;
  }) => void;
}

const STATUS_LABELS: Record<TargetStatus | "all", string> = {
  all: "全部",
  pending: "未同步",
  syncing: "同步中",
  synced: "已同步",
  empty: "已检查无资源",
  failed: "失败",
};

const STATUS_CLASSES: Record<TargetStatus, string> = {
  pending: "text-amber-400",
  syncing: "text-blue-400",
  synced: "text-green-400",
  empty: "text-gray-400",
  failed: "text-red-400",
};

function formatTime(value?: string) {
  if (!value) return "从未";
  return value.slice(0, 16).replace("T", " ");
}

export function PanCatalogSyncPanel({
  onShowToast,
  onSelectMovie,
}: PanCatalogSyncPanelProps) {
  const [status, setStatus] = useState<TargetStatus | "all">("all");
  const [keyword, setKeyword] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TargetResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"discover" | "run" | "one" | null>(null);
  const [activeDoubanId, setActiveDoubanId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const stopRequested = useRef(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: "12",
        status,
      });
      if (keyword.trim()) params.set("keyword", keyword.trim());
      const response = await fetch(`/api/pan-resources/catalog-sync?${params}`);
      const result = await response.json();
      if (result.code !== 200) {
        throw new Error(result.message || "读取同步台账失败");
      }
      setData(result.data);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取同步台账失败";
      setLoadError(message);
      throw error;
    }
  }, [keyword, page, status]);

  useEffect(() => {
    load().catch((error) => {
      onShowToast({
        message: error instanceof Error ? error.message : "读取同步台账失败",
        type: "error",
      });
    });
  }, [load, onShowToast]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/pan-resources/catalog-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (result.code !== 200) throw new Error(result.message || "同步操作失败");
    return result.data as BatchResponse & {
      discovered?: number;
      upserted?: number;
      sourceErrors?: string[];
    };
  }, []);

  const discover = async () => {
    setBusy("discover");
    setMessage("正在收集站内影片目录…");
    try {
      const result = await post({ action: "discover", limit: 5 });
      setMessage(`已发现 ${result.discovered ?? 0} 部影片`);
      const sourceErrorCount = result.sourceErrors?.length ?? 0;
      onShowToast({
        message:
          sourceErrorCount > 0
            ? `影片目录已更新，共 ${result.discovered ?? 0} 部；${sourceErrorCount} 个来源暂不可用`
            : `影片目录已更新，共 ${result.discovered ?? 0} 部`,
        type: sourceErrorCount > 0 ? "warning" : "success",
      });
      await load();
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "发现影片目录失败",
        type: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const runAll = async () => {
    setBusy("run");
    stopRequested.current = false;
    setMessage("正在同步未处理影片…");
    try {
      // 发现与同步合并为一个按钮，用户不需要先理解内部阶段。
      const discovery = await post({ action: "discover", limit: 5 });
      let batch: BatchResponse | null = null;
      let processedTotal = 0;
      let failedTotal = 0;
      let queueStopped = false;
      for (let round = 0; round < 1000; round++) {
        if (stopRequested.current) break;
        batch = (await post({ action: "run", limit: 5 })) as BatchResponse;
        processedTotal += batch.processed;
        failedTotal += batch.failed;
        setMessage(
          `本次已处理 ${processedTotal} 部，剩余 ${batch.remaining} 部，本批新增 ${batch.imported} 条，更新 ${batch.refreshed} 条`
        );
        if (batch.remaining <= 0 || batch.processed === 0) {
          queueStopped = true;
          break;
        }
      }
      await load();
      if (stopRequested.current) {
        setMessage("已暂停，可继续执行剩余影片");
      } else if (
        !queueStopped ||
        failedTotal > 0 ||
        (discovery.sourceErrors?.length ?? 0) > 0
      ) {
        const warningParts = [];
        if (!queueStopped) warningParts.push("达到本次操作的批次上限");
        if (failedTotal > 0) warningParts.push(`${failedTotal} 部影片失败`);
        if ((discovery.sourceErrors?.length ?? 0) > 0) {
          warningParts.push(`${discovery.sourceErrors?.length} 个目录来源暂不可用`);
        }
        onShowToast({
          message: `同步批次完成：${warningParts.join("，")}`,
          type: "warning",
        });
        setMessage("同步批次完成，失败影片可在列表中重试");
      } else {
        onShowToast({ message: "全量影片同步完成", type: "success" });
        setMessage("全量影片同步完成");
      }
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "全量同步失败",
        type: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const syncOne = async (item: TargetItem) => {
    setBusy("one");
    setActiveDoubanId(item.douban_id);
    try {
      const result = await post({
        action: "sync",
        douban_id: item.douban_id,
        limit: 1,
      });
      const failed = result.failed ?? 0;
      onShowToast({
          message:
          failed > 0
            ? `「${item.title}」同步失败，可稍后重试`
            : `「${item.title}」同步完成，新增 ${result.imported ?? 0} 条，更新 ${result.refreshed ?? 0} 条`,
        type: failed > 0 ? "warning" : "success",
      });
      await load();
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "单片同步失败",
        type: "error",
      });
    } finally {
      setActiveDoubanId(null);
      setBusy(null);
    }
  };

  const stop = () => {
    stopRequested.current = true;
    setMessage("正在停止当前批次…");
  };

  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / 12));

  return (
    <section className="bg-[#181818] border border-[#333] rounded-lg p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-white font-medium flex items-center gap-2">
            <DatabaseZap size={18} className="text-[#E50914]" />
            影片网盘同步中心
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            范围为站内展示（含日历）与历史已收录影片；已检查无资源与从未同步分开统计。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={discover}
            disabled={busy !== null}
            className="px-3 py-2 bg-[#333] hover:bg-[#444] disabled:opacity-50 text-white text-xs rounded flex items-center gap-1.5"
          >
            {busy === "discover" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            发现影片
          </button>
          {busy === "run" ? (
            <button
              onClick={stop}
              className="px-3 py-2 bg-red-900/70 hover:bg-red-900 text-white text-xs rounded flex items-center gap-1.5"
            >
              <Square size={13} />
              暂停
            </button>
          ) : (
            <button
              onClick={runAll}
              disabled={busy !== null}
              className="px-3 py-2 bg-[#E50914] hover:bg-[#f6121d] disabled:opacity-50 text-white text-xs rounded flex items-center gap-1.5"
            >
              <DatabaseZap size={14} />
              一键同步未处理
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mb-4">
        {(["all", "pending", "syncing", "synced", "empty", "failed"] as const).map((key) => {
          const count = key === "all" ? data?.stats.total : data?.stats[key];
          return (
            <button
              key={key}
              onClick={() => {
                setStatus(key);
                setPage(1);
              }}
              className={`text-left border rounded px-3 py-2 ${
                status === key ? "border-[#E50914] bg-[#2a1718]" : "border-[#333] bg-[#222]"
              }`}
            >
              <span className="block text-xs text-gray-500">{STATUS_LABELS[key]}</span>
              <b className="text-white text-lg">{data ? count ?? 0 : "—"}</b>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <div className="flex flex-1 min-w-[220px] gap-2">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setKeyword(search);
                setPage(1);
              }
            }}
            placeholder="搜索影片名或豆瓣 ID"
            className="flex-1 bg-[#222] border border-[#333] rounded px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-[#E50914]"
          />
          <button
            onClick={() => {
              setKeyword(search);
              setPage(1);
            }}
            className="px-3 py-2 bg-[#333] hover:bg-[#444] text-white rounded"
            title="搜索"
          >
            <Search size={14} />
          </button>
        </div>
        <button
          onClick={() => load().catch(() => undefined)}
          className="px-3 py-2 bg-[#333] hover:bg-[#444] text-white rounded"
          title="刷新状态"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {message && <p className="text-xs text-blue-300 mb-3">{message}</p>}

      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-300 mb-3">
          <span>同步台账暂不可用：{loadError}</span>
          <button
            onClick={() => load().catch(() => undefined)}
            className="shrink-0 text-white underline underline-offset-2"
          >
            重试
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        {data?.items.map((item) => (
          <div
            key={item.douban_id}
            className="flex items-center gap-3 bg-[#222] border border-[#333] rounded px-3 py-2.5"
          >
            {item.cover ? (
              <img src={item.cover} alt="" className="w-8 h-11 rounded object-cover shrink-0" />
            ) : (
              <div className="w-8 h-11 rounded bg-[#333] shrink-0" />
            )}
            <button
              onClick={() => onSelectMovie(item)}
              className="flex-1 min-w-0 text-left"
              title="打开影片资源管理"
            >
              <p className="text-sm text-white truncate">{item.title}</p>
              <p className="text-[11px] text-gray-500 truncate">
                ID {item.douban_id} · {item.resources_count} 条资源 · 最近 {formatTime(item.last_checked_at)}
              </p>
              {item.last_error && (
                <p className="text-[11px] text-red-400 truncate">{item.last_error}</p>
              )}
            </button>
            <span className={`text-xs shrink-0 ${STATUS_CLASSES[item.status]}`}>
              {item.status === "synced" && <CheckCircle2 size={13} className="inline mr-1" />}
              {item.status === "failed" && <CircleAlert size={13} className="inline mr-1" />}
              {STATUS_LABELS[item.status]}
            </span>
            <button
              onClick={() => syncOne(item)}
              disabled={busy !== null}
              className="p-1.5 text-gray-400 hover:text-white disabled:opacity-40 rounded"
              title="重新同步"
            >
              {activeDoubanId === item.douban_id ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <RotateCcw size={15} />
              )}
            </button>
          </div>
        ))}
        {data && data.items.length === 0 && (
          <p className="text-sm text-gray-500 text-center py-8">暂无符合条件的影片</p>
        )}
        {!data && !loadError && (
          <p className="text-sm text-gray-500 text-center py-8">正在加载同步台账…</p>
        )}
      </div>

      <div className="flex items-center justify-between mt-4 text-xs text-gray-500">
        <span>
          第 {page} / {totalPages} 页
          {data?.stats.syncing ? ` · ${data.stats.syncing} 部处理中` : ""}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            disabled={page <= 1}
            className="p-1.5 bg-[#333] rounded disabled:opacity-30"
            title="上一页"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            disabled={page >= totalPages}
            className="p-1.5 bg-[#333] rounded disabled:opacity-30"
            title="下一页"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}
