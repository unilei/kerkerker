"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Loader2, Film } from "lucide-react";
import {
  searchDouban,
  getSubjectDetail,
  type SuggestItem,
  type Subject,
} from "@/lib/douban-service";
import {
  PAN_BRAND_CONFIGS,
  type PanResource,
} from "@/types/pan-resource";
import { BrandBadge } from "@/components/pan/BrandBadge";
import { PanResourceManager } from "@/components/pan/PanResourceManager";
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
  title: string;
  cover?: string;
  year?: string;
  internal_id?: number;
}

const inputClass =
  "flex-1 bg-[#333] border border-[#444] rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#E50914] transition-colors";

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
  }, [loadRecent]);

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
      const data = await searchDouban(query);
      const items: SearchResultItem[] =
        data.suggest?.length > 0
          ? data.suggest.map((item: SuggestItem) => ({
              id: item.id,
              title: item.title,
              cover: item.img,
              year: item.year,
            }))
          : (data.advanced || []).map((item: Subject) => ({
              id: item.id,
              title: item.title,
              cover: item.cover,
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
      const detail = await getSubjectDetail(doubanId);
      if (detail?.id) {
        setSelectedMovie((prev) =>
          prev && prev.douban_id === doubanId
            ? {
                ...prev,
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
      const detail = await getSubjectDetail(id);
      if (detail?.id) {
        setSelectedMovie({
          douban_id: detail.id,
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
