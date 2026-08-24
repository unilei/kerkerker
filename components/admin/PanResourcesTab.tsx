"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  CalendarClock,
  DatabaseZap,
  Film,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  PAN_BRAND_CONFIGS,
  type PanResource,
} from "@/types/pan-resource";
import { BrandBadge } from "@/components/pan/BrandBadge";
import { PanResourceManager } from "@/components/pan/PanResourceManager";
import { PanCatalogSyncPanel } from "./PanCatalogSyncPanel";
import { PanSyncSchedulerPanel } from "./PanSyncSchedulerPanel";
import type { PanResourcesTabProps } from "./types";

// 搜索结果统一结构
interface SearchResultItem {
  id: string;
  title: string;
  cover: string;
  year?: string;
}

// 当前选中管理的影片
interface SelectedMovie {
  douban_id: string;
  content_id?: string;
  title: string;
  cover?: string;
  year?: string;
  internal_id?: number;
}

interface ContentDetailResponse {
  id: string;
  content_id?: string;
  title: string;
  cover: string;
  release_year: string;
  internal_id?: number;
}

// kkpans 同步状态
interface SyncState {
  last_incremental_at: string | null;
  last_backfill_at: string | null;
}

interface SyncStatsView {
  mode: string;
  pulled: number;
  imported: number;
  skippedExisting: number;
  unmatched: number;
  disabled: number;
  refreshed?: number;
  checkedTitles: number;
  durationMs: number;
  categoryErrors?: number;
  searchErrors?: number;
  doubanErrors?: number;
  sourceErrors?: number;
  failed?: boolean;
}

const inputClass =
  "flex-1 bg-[#333] border border-[#444] rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#E50914] transition-colors";

type Tool = "catalog" | "scheduler" | "kkpan" | "search" | "resource";

function ToolModal({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[min(92vh,960px)] w-full max-w-6xl flex-col overflow-hidden border border-[#444] bg-[#141414] shadow-2xl sm:rounded-lg">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[#333] bg-[#181818] px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-medium text-white">
              {title}
            </h2>
            {description && <p className="mt-1 text-xs text-gray-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-2 text-gray-400 transition-colors hover:bg-[#333] hover:text-white"
            title="关闭"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-3 sm:p-5">{children}</div>
      </div>
    </div>
  );
}

async function fetchContentDetail(id: string): Promise<ContentDetailResponse | null> {
  const response = await fetch(`/api/content/detail/${encodeURIComponent(id)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { data?: ContentDetailResponse };
  return payload.data?.id ? payload.data : null;
}

export function PanResourcesTab({ onShowToast, onShowConfirm }: PanResourcesTabProps) {
  // 影片搜索
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // 选中的影片
  const [selectedMovie, setSelectedMovie] = useState<SelectedMovie | null>(null);
  const [activeTool, setActiveTool] = useState<Tool | null>(null);

  // 最近录入（未选中影片时展示）
  const [recentResources, setRecentResources] = useState<PanResource[]>([]);

  // kkpans 自动同步
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [syncingMode, setSyncingMode] = useState<"incremental" | "backfill" | null>(null);
  const [syncResult, setSyncResult] = useState<SyncStatsView | null>(null);
  const [backfillLimit, setBackfillLimit] = useState("100");
  const closeTool = useCallback(() => setActiveTool(null), []);

  // 加载同步状态
  const loadSyncState = useCallback(async () => {
    try {
      const response = await fetch("/api/pan-resources/sync-kkpan");
      const result = await response.json();
      if (result.code === 200) {
        setSyncState(result.data);
      }
    } catch {
      // 静默失败
    }
  }, []);

  // 加载最近录入
  const loadRecent = useCallback(async () => {
    try {
      const response = await fetch("/api/pan-resources?all=true&limit=20");
      const result = await response.json();
      if (result.code === 200 && result.data?.resources) {
        setRecentResources(result.data.resources);
      }
    } catch {
      // 静默失败，非关键数据
    }
  }, []);

  useEffect(() => {
    loadRecent();
    loadSyncState();
  }, [loadRecent, loadSyncState]);

  // 执行同步（incremental=增量 / backfill=批量补库）
  const handleSync = async (mode: "incremental" | "backfill") => {
    setSyncingMode(mode);
    setSyncResult(null);
    try {
      const limit =
        mode === "backfill"
          ? Math.min(Math.max(parseInt(backfillLimit, 10) || 100, 1), 200)
          : undefined;
      const response = await fetch("/api/pan-resources/sync-kkpan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, limit }),
      });
      const result = await response.json();
      if (result.code !== 200) {
        throw new Error(result.message || "同步失败");
      }
      setSyncResult(result.data.stats);
      onShowToast({
        message: `同步完成：新入库 ${result.data.stats.imported} 条`,
        type: "success",
      });
      loadSyncState();
      loadRecent();
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "同步失败",
        type: "error",
      });
    } finally {
      setSyncingMode(null);
    }
  };

  // 按片名搜索豆瓣
  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      onShowToast({ message: "请输入影片名称", type: "warning" });
      return;
    }

    setIsSearching(true);
    setHasSearched(true);
    try {
      const response = await fetch(
        `/api/content/search?q=${encodeURIComponent(query)}`,
        { cache: "no-store", signal: AbortSignal.timeout(15_000) }
      );
      const result = (await response.json()) as {
        code?: number;
        message?: string;
        data?: {
          items?: Array<{
            id: string;
            title: string;
            cover?: string;
            release_date?: string;
          }>;
        };
      };
      if (!response.ok || result.code !== 200) {
        throw new Error(result.message || `内容搜索失败（HTTP ${response.status}）`);
      }
      const items: SearchResultItem[] = (result.data?.items || []).map((item) => ({
        id: item.id,
        title: item.title,
        cover: item.cover || "",
        year: item.release_date || undefined,
      }));
      setSearchResults(items);
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "搜索失败",
        type: "error",
      });
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // 补充影片详情（internal_id / 封面），失败不影响录入
  const enrichMovie = useCallback(async (doubanId: string) => {
    try {
      const detail = await fetchContentDetail(doubanId);
      if (detail) {
        setSelectedMovie((prev) =>
          prev && prev.douban_id === doubanId
            ? {
                ...prev,
                content_id: detail.content_id ?? prev.content_id,
                title: detail.title || prev.title,
                cover: detail.cover || prev.cover,
                year: detail.release_year || prev.year,
                internal_id: detail.internal_id ?? prev.internal_id,
              }
            : prev
        );
      }
    } catch {
      // 忽略
    }
  }, []);

  const handleSelectCatalogMovie = useCallback(
    (movie: {
      douban_id: string;
      title: string;
      cover?: string;
      year?: string;
    }) => {
      setSelectedMovie(movie);
      setActiveTool("resource");
      setSearchResults([]);
      setHasSearched(false);
      setSearchQuery("");
      enrichMovie(movie.douban_id);
    },
    [enrichMovie]
  );

  // 选中影片（搜索结果点击）
  const handleSelectMovie = (item: SearchResultItem) => {
    setSelectedMovie({
      douban_id: item.id,
      title: item.title,
      cover: item.cover,
      year: item.year,
    });
    setActiveTool("resource");
    setSearchResults([]);
    setHasSearched(false);
    setSearchQuery("");
    enrichMovie(item.id);
  };

  // 直接使用豆瓣 ID
  const handleDirectId = async () => {
    const id = searchQuery.trim();
    if (!/^\d+$/.test(id)) {
      onShowToast({ message: "请输入纯数字的豆瓣 ID", type: "warning" });
      return;
    }

    setSelectedMovie({ douban_id: id, title: `豆瓣 ${id}` });
    setActiveTool("resource");
    setSearchResults([]);
    setHasSearched(false);
    setSearchQuery("");
    // 补充详情，拿到真实片名与 internal_id 后覆盖占位
    try {
      const detail = await fetchContentDetail(id);
      if (detail) {
        setSelectedMovie({
          douban_id: detail.id,
          content_id: detail.content_id,
          title: detail.title,
          cover: detail.cover,
          year: detail.release_year,
          internal_id: detail.internal_id,
        });
      }
    } catch {
      // 忽略，保留占位标题
    }
  };

  // 从最近录入直接跳转
  const handleSelectRecent = (resource: PanResource) => {
    const doubanId = resource.douban_id;
    setSelectedMovie({
      douban_id: doubanId,
      content_id: resource.content_id,
      title: resource.movie_title || `豆瓣 ${doubanId}`,
    });
    setActiveTool("resource");
    enrichMovie(doubanId);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-[#333] pb-5">
        <h2 className="text-lg font-medium text-white">网盘资源工作台</h2>
        <p className="mt-1 text-sm text-gray-500">
          选择需要执行的操作，配置和长列表会在独立窗口中打开。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setActiveTool("catalog")}
          className="group flex min-h-28 items-start gap-4 rounded-lg border border-[#333] bg-[#181818] p-5 text-left transition-colors hover:border-[#555] hover:bg-[#1d1d1d]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-red-950/50 text-[#E50914]">
            <DatabaseZap size={20} />
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-white">影片同步中心</span>
            <span className="mt-1 block text-xs leading-5 text-gray-500">
              发现站内影片、查看同步状态并重新同步单片。
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("scheduler")}
          className="group flex min-h-28 items-start gap-4 rounded-lg border border-[#333] bg-[#181818] p-5 text-left transition-colors hover:border-[#555] hover:bg-[#1d1d1d]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-blue-950/50 text-blue-300">
            <CalendarClock size={20} />
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-white">自动同步与日志</span>
            <span className="mt-1 block text-xs leading-5 text-gray-500">
              配置每日任务，查看实时进度和最近运行日志。
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("kkpan")}
          className="group flex min-h-28 items-start gap-4 rounded-lg border border-[#333] bg-[#181818] p-5 text-left transition-colors hover:border-[#555] hover:bg-[#1d1d1d]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-emerald-950/50 text-emerald-300">
            <RefreshCw size={20} />
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-white">kkpans 数据同步</span>
            <span className="mt-1 block text-xs leading-5 text-gray-500">
              拉取最新转存记录，或按豆瓣热榜批量补库。
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("search")}
          className="group flex min-h-28 items-start gap-4 rounded-lg border border-[#333] bg-[#181818] p-5 text-left transition-colors hover:border-[#555] hover:bg-[#1d1d1d]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-amber-950/50 text-amber-300">
            <Search size={20} />
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-white">查找并录入资源</span>
            <span className="mt-1 block text-xs leading-5 text-gray-500">
              按片名或豆瓣 ID 找到影片，再管理网盘链接。
            </span>
          </span>
        </button>
      </div>

      <section className="border-t border-[#333] pt-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-medium text-white">最近录入</h3>
            <p className="mt-1 text-xs text-gray-600">点击影片可继续管理资源</p>
          </div>
          <button
            type="button"
            onClick={() => setActiveTool("search")}
            className="flex items-center gap-1.5 rounded bg-[#333] px-3 py-2 text-xs text-white transition-colors hover:bg-[#444]"
          >
            <Film size={14} />
            录入影片
          </button>
        </div>
        {recentResources.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500">
            暂无网盘资源
          </p>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {recentResources.slice(0, 8).map((resource) => (
              <button
                key={resource.id}
                type="button"
                onClick={() => handleSelectRecent(resource)}
                className="flex min-w-0 items-center gap-3 rounded border border-[#333] bg-[#181818] px-4 py-3 text-left transition-colors hover:border-[#555] hover:bg-[#202020]"
              >
                <BrandBadge brand={resource.brand} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-white">
                    {resource.movie_title || `豆瓣 ${resource.douban_id}`}
                    <span className="text-gray-500"> · {resource.title}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-gray-600">
                    {PAN_BRAND_CONFIGS[resource.brand].name} · {resource.updated_at?.slice(0, 10)}
                    {!resource.enabled ? " · 已禁用" : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <ToolModal
        open={activeTool === "catalog"}
        title="影片网盘同步中心"
        description="发现站内影片、区分同步状态并执行单片或批量同步。"
        onClose={closeTool}
      >
        <PanCatalogSyncPanel
          onShowToast={onShowToast}
          onSelectMovie={handleSelectCatalogMovie}
        />
      </ToolModal>

      <ToolModal
        open={activeTool === "scheduler"}
        title="自动同步与运行日志"
        description="定时任务由应用内部执行，配置、进度和日志都保存在数据库中。"
        onClose={closeTool}
      >
        <PanSyncSchedulerPanel onShowToast={onShowToast} />
      </ToolModal>

      <ToolModal
        open={activeTool === "kkpan"}
        title="kkpans 数据同步"
        description="只同步已成功转存的资源。"
        onClose={closeTool}
      >
        <section className="rounded-lg border border-[#333] bg-[#181818] p-4 sm:p-6">
          <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-500">
            <span>上次增量：{syncState?.last_incremental_at?.slice(0, 19).replace("T", " ") || "从未"}</span>
            <span>上次补库：{syncState?.last_backfill_at?.slice(0, 19).replace("T", " ") || "从未"}</span>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => handleSync("incremental")}
              disabled={syncingMode !== null}
              className="flex items-center justify-center gap-2 rounded bg-[#E50914] px-4 py-2.5 text-sm text-white transition-colors hover:bg-[#f6121d] disabled:opacity-50"
            >
              {syncingMode === "incremental" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              增量同步
            </button>
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => handleSync("backfill")}
                disabled={syncingMode !== null}
                className="flex flex-1 items-center justify-center gap-2 rounded bg-[#333] px-4 py-2.5 text-sm text-white transition-colors hover:bg-[#444] disabled:opacity-50 sm:flex-none"
              >
                {syncingMode === "backfill" ? <Loader2 size={14} className="animate-spin" /> : <DatabaseZap size={14} />}
                批量补库
              </button>
              <input
                type="number"
                min={1}
                max={200}
                value={backfillLimit}
                onChange={(event) => setBackfillLimit(event.target.value)}
                className="w-20 rounded border border-[#444] bg-[#333] px-2 py-2.5 text-sm text-white focus:border-[#E50914] focus:outline-none"
                aria-label="补库影片数上限"
              />
              <span className="shrink-0 text-xs text-gray-500">部</span>
            </div>
          </div>
          {syncResult && (
            <div className="mt-5 border-t border-[#333] pt-4 text-xs text-gray-400">
              <p className="mb-2 text-sm font-medium text-white">
                {syncResult.mode === "backfill" ? "批量补库" : "增量同步"}完成
                <span className="ml-2 text-xs font-normal text-gray-500">耗时 {(syncResult.durationMs / 1000).toFixed(1)} 秒</span>
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                <span>拉取 <b className="text-white">{syncResult.pulled}</b></span>
                <span className="text-green-400">新增 <b>{syncResult.imported}</b></span>
                <span>跳过 <b className="text-white">{syncResult.skippedExisting}</b></span>
                <span>未匹配 <b className="text-white">{syncResult.unmatched}</b></span>
                {syncResult.mode === "incremental" && <span className="text-amber-400">禁用 {syncResult.disabled} · 换新 {syncResult.refreshed ?? 0}</span>}
              </div>
            </div>
          )}
          <p className="mt-5 text-xs leading-5 text-gray-600">
            增量同步会拉取最新转存记录并检查旧资源；批量补库按豆瓣热门影片逐片搜索。
          </p>
        </section>
      </ToolModal>

      <ToolModal
        open={activeTool === "search"}
        title="查找影片"
        description="搜索影片或直接输入豆瓣 ID，选中后进入资源管理。"
        onClose={closeTool}
      >
        <section className="rounded-lg border border-[#333] bg-[#181818] p-4 sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="输入影片名称或豆瓣 ID"
              className={inputClass}
            />
            <button
              type="button"
              onClick={handleSearch}
              disabled={isSearching}
              className="flex items-center justify-center gap-2 rounded bg-[#E50914] px-4 py-2 text-white transition-colors hover:bg-[#f6121d] disabled:opacity-50"
            >
              {isSearching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              搜索
            </button>
            <button
              type="button"
              onClick={handleDirectId}
              className="rounded bg-[#333] px-4 py-2 text-white transition-colors hover:bg-[#444]"
            >
              用 ID 直达
            </button>
          </div>
          {hasSearched && (
            <div className="mt-5">
              {searchResults.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-500">{isSearching ? "搜索中..." : "未找到相关影片"}</p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {searchResults.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectMovie(item)}
                      className="group min-w-0 rounded-lg border border-[#333] bg-[#222] p-2 text-left transition-colors hover:border-[#E50914] hover:bg-[#2a2a2a]"
                    >
                      <div className="mb-2 aspect-2/3 overflow-hidden rounded bg-[#333]">
                        {item.cover ? (
                          <img src={item.cover} alt={item.title} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center"><Film size={24} className="text-gray-600" /></div>
                        )}
                      </div>
                      <p className="truncate text-sm text-white">{item.title}</p>
                      <p className="mt-0.5 truncate text-xs text-gray-500">{item.year ? `${item.year} · ` : ""}ID: {item.id}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </ToolModal>

      <ToolModal
        open={activeTool === "resource" && selectedMovie !== null}
        title={selectedMovie ? `资源管理 · ${selectedMovie.title}` : "资源管理"}
        description="添加、编辑或禁用该影片的网盘资源。"
        onClose={closeTool}
      >
        {selectedMovie && (
          <div className="rounded-lg border border-[#333] bg-[#181818] p-4 sm:p-6">
            <div className="mb-6 flex items-center gap-3 border-b border-[#333] pb-4">
              {selectedMovie.cover && <img src={selectedMovie.cover} alt={selectedMovie.title} className="h-14 w-10 shrink-0 rounded object-cover" />}
              <div className="min-w-0">
                <p className="truncate font-medium text-white">{selectedMovie.title}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  豆瓣 ID: {selectedMovie.douban_id}{selectedMovie.year ? ` · ${selectedMovie.year}` : ""}{selectedMovie.internal_id ? ` · internal_id: ${selectedMovie.internal_id}` : ""}
                </p>
              </div>
            </div>
            <PanResourceManager
              movie={selectedMovie}
              onShowToast={onShowToast}
              onShowConfirm={onShowConfirm}
              onChanged={loadRecent}
            />
          </div>
        )}
      </ToolModal>
    </div>
  );
}
