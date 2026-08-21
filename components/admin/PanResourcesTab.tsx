"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Loader2, Film, RefreshCw, DatabaseZap } from "lucide-react";
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

  // 最近录入（未选中影片时展示）
  const [recentResources, setRecentResources] = useState<PanResource[]>([]);

  // kkpans 自动同步
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [syncingMode, setSyncingMode] = useState<"incremental" | "backfill" | null>(null);
  const [syncResult, setSyncResult] = useState<SyncStatsView | null>(null);
  const [backfillLimit, setBackfillLimit] = useState("100");

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
    enrichMovie(doubanId);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="space-y-6">
      {/* 说明 */}
      <div className="bg-[#181818] border border-[#333] rounded-lg p-4">
        <p className="text-sm text-gray-400">
          为影片录入夸克 / 百度 / 迅雷 / 光鸭 / UC 网盘分享链接。支持整段粘贴资源文本自动解析，
          也可直接到影片详情页点「管理」录入。录入后会在详情页「网盘资源」区块展示。
        </p>
      </div>

      <PanCatalogSyncPanel
        onShowToast={onShowToast}
        onSelectMovie={handleSelectCatalogMovie}
      />

      <PanSyncSchedulerPanel onShowToast={onShowToast} />

      {/* kkpans 自动同步 */}
      <div className="bg-[#181818] border border-[#333] rounded-lg p-6">
        <h3 className="text-white font-medium mb-4 flex items-center gap-2">
          <RefreshCw size={18} className="text-[#E50914]" />
          kkpans 自动同步
        </h3>

        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 mb-4">
          <span>
            上次增量：{syncState?.last_incremental_at?.slice(0, 19).replace("T", " ") || "从未"}
          </span>
          <span>
            上次补库：{syncState?.last_backfill_at?.slice(0, 19).replace("T", " ") || "从未"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => handleSync("incremental")}
            disabled={syncingMode !== null}
            className="px-4 py-2 bg-[#E50914] hover:bg-[#f6121d] disabled:opacity-50 text-white text-sm rounded transition-colors flex items-center gap-2"
          >
            {syncingMode === "incremental" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            增量同步（最新转存）
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSync("backfill")}
              disabled={syncingMode !== null}
              className="px-4 py-2 bg-[#333] hover:bg-[#444] disabled:opacity-50 text-white text-sm rounded transition-colors flex items-center gap-2"
            >
              {syncingMode === "backfill" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <DatabaseZap size={14} />
              )}
              批量补库（豆瓣热榜）
            </button>
            <input
              type="number"
              min={1}
              max={200}
              value={backfillLimit}
              onChange={(e) => setBackfillLimit(e.target.value)}
              className="w-20 bg-[#333] border border-[#444] rounded px-2 py-2 text-sm text-white focus:outline-none focus:border-[#E50914]"
              title="补库影片数上限"
            />
            <span className="text-xs text-gray-500">部影片</span>
          </div>
        </div>

        {/* 同步结果统计 */}
        {syncResult && (
          <div className="mt-4 bg-[#222] border border-[#333] rounded-lg p-4 text-sm text-gray-300">
            <p className="text-white font-medium mb-2">
              {syncResult.mode === "backfill" ? "批量补库" : "增量同步"}结果
              <span className="text-gray-500 ml-2 text-xs">
                耗时 {(syncResult.durationMs / 1000).toFixed(1)}s
              </span>
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <span>拉到资源 <b className="text-white">{syncResult.pulled}</b></span>
              <span className="text-green-400">新入库 <b>{syncResult.imported}</b></span>
              <span>已存在跳过 <b className="text-white">{syncResult.skippedExisting}</b></span>
              <span>未匹配影片 <b className="text-white">{syncResult.unmatched}</b></span>
              {syncResult.mode === "incremental" && (
                <span className="text-amber-400">
                  失效禁用 <b>{syncResult.disabled}</b>，换新 <b>{syncResult.refreshed ?? 0}</b>（检查 {syncResult.checkedTitles} 部）
                </span>
              )}
              {(syncResult.categoryErrors ||
                syncResult.searchErrors ||
                syncResult.doubanErrors ||
                syncResult.sourceErrors) && (
                <span className="text-red-400">
                  上游错误{" "}
                  {(
                    (syncResult.categoryErrors || 0) +
                    (syncResult.searchErrors || 0) +
                    (syncResult.doubanErrors || 0) +
                    (syncResult.sourceErrors || 0)
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        <p className="mt-3 text-xs text-gray-600">
          增量同步拉取 kkpans 最新转存成功的资源，自动匹配豆瓣影片入库，并对 kkpan 来源的旧资源做失效检测；
          批量补库按豆瓣热门影片逐片搜索 kkpans 入库。仅转存成功的资源会被同步。
        </p>
      </div>

      {/* 影片搜索 */}
      <div className="bg-[#181818] border border-[#333] rounded-lg p-6">
        <h3 className="text-white font-medium mb-4 flex items-center gap-2">
          <Film size={18} className="text-[#E50914]" />
          查找影片
        </h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="输入影片名称搜索，或直接输入豆瓣 ID"
            className={inputClass}
          />
          <button
            onClick={handleSearch}
            disabled={isSearching}
            className="px-4 py-2 bg-[#E50914] hover:bg-[#f6121d] disabled:opacity-50 text-white rounded transition-colors flex items-center gap-2 shrink-0"
          >
            {isSearching ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Search size={16} />
            )}
            搜索
          </button>
          <button
            onClick={handleDirectId}
            className="px-4 py-2 bg-[#333] hover:bg-[#444] text-white rounded transition-colors shrink-0"
          >
            用 ID 直达
          </button>
        </div>

        {/* 搜索结果 */}
        {hasSearched && (
          <div className="mt-4">
            {searchResults.length === 0 ? (
              <p className="text-sm text-gray-500 py-4 text-center">
                {isSearching ? "搜索中..." : "未找到相关影片"}
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 max-h-96 overflow-y-auto p-1">
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleSelectMovie(item)}
                    className="text-left bg-[#222] hover:bg-[#2a2a2a] border border-[#333] hover:border-[#E50914] rounded-lg p-2 transition-colors group"
                  >
                    <div className="aspect-2/3 rounded overflow-hidden bg-[#333] mb-2">
                      {item.cover ? (
                        <img
                          src={item.cover}
                          alt={item.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Film size={24} className="text-gray-600" />
                        </div>
                      )}
                    </div>
                    <p className="text-sm text-white truncate">{item.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.year ? `${item.year} · ` : ""}ID: {item.id}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 选中影片的管理面板 */}
      {selectedMovie ? (
        <div className="bg-[#181818] border border-[#333] rounded-lg p-6">
          {/* 影片信息 */}
          <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#333]">
            <div className="flex items-center gap-3 min-w-0">
              {selectedMovie.cover ? (
                <img
                  src={selectedMovie.cover}
                  alt={selectedMovie.title}
                  className="w-10 h-14 rounded object-cover shrink-0"
                />
              ) : null}
              <div className="min-w-0">
                <h3 className="text-white font-medium truncate">
                  {selectedMovie.title}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  豆瓣 ID: {selectedMovie.douban_id}
                  {selectedMovie.year ? ` · ${selectedMovie.year}` : ""}
                  {selectedMovie.internal_id
                    ? ` · internal_id: ${selectedMovie.internal_id}`
                    : ""}
                </p>
              </div>
            </div>
            <button
              onClick={() => setSelectedMovie(null)}
              className="px-3 py-1.5 bg-[#333] hover:bg-[#444] text-gray-300 hover:text-white text-sm rounded transition-colors shrink-0"
            >
              关闭
            </button>
          </div>

          <PanResourceManager
            movie={selectedMovie}
            onShowToast={onShowToast}
            onShowConfirm={onShowConfirm}
            onChanged={loadRecent}
          />
        </div>
      ) : (
        /* 未选中影片时展示最近录入 */
        <div className="bg-[#181818] border border-[#333] rounded-lg p-6">
          <h3 className="text-white font-medium mb-4">最近录入</h3>
          {recentResources.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">
              暂无网盘资源，搜索影片后开始录入
            </p>
          ) : (
            <div className="space-y-2">
              {recentResources.map((resource) => (
                <button
                  key={resource.id}
                  onClick={() => handleSelectRecent(resource)}
                  className="w-full flex items-center gap-3 bg-[#222] hover:bg-[#2a2a2a] border border-[#333] hover:border-[#444] rounded-lg px-4 py-3 transition-colors text-left"
                >
                  <BrandBadge brand={resource.brand} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">
                      {resource.movie_title || `豆瓣 ${resource.douban_id}`}
                      <span className="text-gray-500"> · {resource.title}</span>
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {PAN_BRAND_CONFIGS[resource.brand].name} · 更新于{" "}
                      {resource.updated_at?.slice(0, 10)}
                      {!resource.enabled && (
                        <span className="ml-1 text-gray-600">（已禁用）</span>
                      )}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
