"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Plus,
  Edit2,
  Trash2,
  X,
  Loader2,
  ExternalLink,
  Power,
  Film,
} from "lucide-react";
import {
  searchDouban,
  getSubjectDetail,
  type SuggestItem,
  type Subject,
} from "@/lib/douban-service";
import {
  PAN_BRANDS,
  PAN_BRAND_CONFIGS,
  type PanBrand,
  type PanResource,
} from "@/types/pan-resource";
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

const EMPTY_FORM = {
  brand: "quark" as PanBrand,
  title: "",
  url: "",
  size: "",
  format: "",
  note: "",
};

const inputClass =
  "w-full bg-[#333] border border-[#444] rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#E50914] transition-colors";

export function PanResourcesTab({ onShowToast, onShowConfirm }: PanResourcesTabProps) {
  // 影片搜索
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // 选中的影片
  const [selectedMovie, setSelectedMovie] = useState<SelectedMovie | null>(null);

  // 该片资源列表
  const [resources, setResources] = useState<PanResource[]>([]);
  const [isLoadingResources, setIsLoadingResources] = useState(false);

  // 最近录入（未选中影片时展示）
  const [recentResources, setRecentResources] = useState<PanResource[]>([]);

  // 添加/编辑表单
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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

  // 加载某片的全部资源（含禁用）
  const loadResources = useCallback(async (doubanId: string) => {
    setIsLoadingResources(true);
    try {
      const response = await fetch(
        `/api/pan-resources?all=true&douban_id=${encodeURIComponent(doubanId)}`
      );
      const result = await response.json();
      if (result.code === 200 && result.data?.resources) {
        setResources(result.data.resources);
      }
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "加载资源失败",
        type: "error",
      });
    } finally {
      setIsLoadingResources(false);
    }
  }, [onShowToast]);

  // 选中影片（搜索结果点击）
  const handleSelectMovie = async (item: SearchResultItem) => {
    setSelectedMovie({
      douban_id: item.id,
      title: item.title,
      cover: item.cover,
      year: item.year,
    });
    setSearchResults([]);
    setHasSearched(false);
    setSearchQuery("");
    setForm(EMPTY_FORM);
    setEditingId(null);
    loadResources(item.id);

    // 补充 internal_id（跨源稳定关联键，失败不影响录入）
    try {
      const detail = await getSubjectDetail(item.id);
      if (detail?.internal_id) {
        setSelectedMovie((prev) =>
          prev && prev.douban_id === item.id
            ? { ...prev, internal_id: detail.internal_id }
            : prev
        );
      }
    } catch {
      // 忽略
    }
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
    setForm(EMPTY_FORM);
    setEditingId(null);
    loadResources(id);

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
  const handleSelectRecent = async (resource: PanResource) => {
    const doubanId = resource.douban_id;
    setSelectedMovie({
      douban_id: doubanId,
      title: resource.movie_title || `豆瓣 ${doubanId}`,
    });
    setForm(EMPTY_FORM);
    setEditingId(null);
    loadResources(doubanId);

    try {
      const detail = await getSubjectDetail(doubanId);
      if (detail?.id) {
        setSelectedMovie((prev) =>
          prev && prev.douban_id === doubanId
            ? {
                ...prev,
                title: detail.title,
                cover: detail.cover,
                year: detail.release_year,
                internal_id: detail.internal_id,
              }
            : prev
        );
      }
    } catch {
      // 忽略
    }
  };

  // 提交（新增/编辑）
  const handleSubmit = async () => {
    if (!selectedMovie) return;

    if (!form.title.trim()) {
      onShowToast({ message: "请输入资源名称", type: "warning" });
      return;
    }
    if (!form.url.trim()) {
      onShowToast({ message: "请输入分享链接", type: "warning" });
      return;
    }
    if (!/^https?:\/\//.test(form.url.trim())) {
      onShowToast({ message: "分享链接需以 http/https 开头", type: "warning" });
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        douban_id: selectedMovie.douban_id,
        internal_id: selectedMovie.internal_id,
        movie_title: selectedMovie.title,
        brand: form.brand,
        title: form.title.trim(),
        url: form.url.trim(),
        size: form.size.trim() || undefined,
        format: form.format.trim() || undefined,
        note: form.note.trim() || undefined,
      };

      const response = await fetch("/api/pan-resources", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId ? { id: editingId, ...payload } : payload),
      });
      const result = await response.json();

      if (result.code !== 200) {
        throw new Error(result.message || "保存失败");
      }

      onShowToast({
        message: editingId ? "更新成功" : "添加成功",
        type: "success",
      });
      setForm(EMPTY_FORM);
      setEditingId(null);
      loadResources(selectedMovie.douban_id);
      loadRecent();
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "保存失败",
        type: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // 进入编辑
  const handleEdit = (resource: PanResource) => {
    setEditingId(resource.id);
    setForm({
      brand: resource.brand,
      title: resource.title,
      url: resource.url,
      size: resource.size || "",
      format: resource.format || "",
      note: resource.note || "",
    });
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  // 启用/禁用
  const handleToggle = async (resource: PanResource) => {
    try {
      const response = await fetch("/api/pan-resources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: resource.id, enabled: !resource.enabled }),
      });
      const result = await response.json();
      if (result.code !== 200) {
        throw new Error(result.message || "操作失败");
      }
      onShowToast({
        message: resource.enabled ? "已禁用" : "已启用",
        type: "success",
      });
      if (selectedMovie) loadResources(selectedMovie.douban_id);
      loadRecent();
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "操作失败",
        type: "error",
      });
    }
  };

  // 删除
  const handleDelete = (resource: PanResource) => {
    onShowConfirm({
      title: "删除网盘资源",
      message: `确定要删除「${PAN_BRAND_CONFIGS[resource.brand].name} · ${resource.title}」吗？此操作不可恢复！`,
      danger: true,
      onConfirm: async () => {
        try {
          const response = await fetch(
            `/api/pan-resources?id=${encodeURIComponent(resource.id)}`,
            { method: "DELETE" }
          );
          const result = await response.json();
          if (result.code !== 200) {
            throw new Error(result.message || "删除失败");
          }
          onShowToast({ message: "删除成功", type: "success" });
          if (editingId === resource.id) handleCancelEdit();
          if (selectedMovie) loadResources(selectedMovie.douban_id);
          loadRecent();
        } catch (error) {
          onShowToast({
            message: error instanceof Error ? error.message : "删除失败",
            type: "error",
          });
        }
      },
    });
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="space-y-6">
      {/* 说明 */}
      <div className="bg-[#181818] border border-[#333] rounded-lg p-4">
        <p className="text-sm text-gray-400">
          为影片录入夸克 / 百度 / 迅雷 / 光鸭 / UC 网盘分享链接，录入后会在影片详情页「网盘资源」区块展示。先搜索并选中影片，再添加资源。
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
              onClick={() => {
                setSelectedMovie(null);
                setResources([]);
                handleCancelEdit();
              }}
              className="p-2 text-gray-500 hover:text-white transition-colors shrink-0"
              title="关闭"
            >
              <X size={18} />
            </button>
          </div>

          {/* 添加/编辑表单 */}
          <div className="mb-6">
            <h4 className="text-sm text-gray-400 font-medium mb-3 flex items-center gap-2">
              <Plus size={14} />
              {editingId ? "编辑资源" : "添加资源"}
            </h4>

            {/* 品牌选择 */}
            <div className="flex flex-wrap gap-2 mb-3">
              {PAN_BRANDS.map((brand) => {
                const config = PAN_BRAND_CONFIGS[brand];
                const active = form.brand === brand;
                return (
                  <button
                    key={brand}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, brand }))}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${
                      active
                        ? "border-[#E50914] bg-[#E50914]/10 text-white"
                        : "border-[#444] bg-[#222] text-gray-400 hover:text-white hover:border-[#555]"
                    }`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full ${config.badgeClass} flex items-center justify-center text-[10px] text-white font-bold`}
                    >
                      {config.shortName}
                    </span>
                    <span className="text-sm">{config.name}</span>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">
                  资源名称 *
                </label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, title: e.target.value }))
                  }
                  placeholder="如：大濛.2025.4K.中字"
                  className={inputClass}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">
                  分享链接 *
                </label>
                <input
                  type="text"
                  value={form.url}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, url: e.target.value }))
                  }
                  placeholder="https://pan.quark.cn/s/xxxxxx"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  大小（如 2.3GB）
                </label>
                <input
                  type="text"
                  value={form.size}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, size: e.target.value }))
                  }
                  placeholder="2.3GB"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  格式（如 MP4）
                </label>
                <input
                  type="text"
                  value={form.format}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, format: e.target.value }))
                  }
                  placeholder="MP4"
                  className={inputClass}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">
                  备注（可选）
                </label>
                <input
                  type="text"
                  value={form.note}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, note: e.target.value }))
                  }
                  placeholder="如：内嵌中字 / 全20集 / 需要会员"
                  className={inputClass}
                />
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={handleSubmit}
                disabled={isSaving}
                className="px-6 py-2 bg-[#E50914] hover:bg-[#f6121d] disabled:opacity-50 text-white rounded transition-colors flex items-center gap-2"
              >
                {isSaving ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Plus size={16} />
                )}
                {editingId ? "保存修改" : "添加资源"}
              </button>
              {editingId && (
                <button
                  onClick={handleCancelEdit}
                  className="px-6 py-2 bg-[#333] hover:bg-[#444] text-white rounded transition-colors"
                >
                  取消编辑
                </button>
              )}
            </div>
          </div>

          {/* 该片资源列表 */}
          <div>
            <h4 className="text-sm text-gray-400 font-medium mb-3">
              该片资源（{resources.length}）
            </h4>
            {isLoadingResources ? (
              <div className="py-8 flex justify-center">
                <Loader2 size={24} className="animate-spin text-gray-600" />
              </div>
            ) : resources.length === 0 ? (
              <p className="text-sm text-gray-500 py-4 text-center">
                暂无资源，使用上方表单添加
              </p>
            ) : (
              <div className="space-y-2">
                {resources.map((resource) => {
                  const config = PAN_BRAND_CONFIGS[resource.brand];
                  return (
                    <div
                      key={resource.id}
                      className={`flex items-center gap-3 bg-[#222] border rounded-lg px-4 py-3 ${
                        editingId === resource.id
                          ? "border-[#E50914]"
                          : "border-[#333]"
                      } ${!resource.enabled ? "opacity-50" : ""}`}
                    >
                      <span
                        className={`w-8 h-8 rounded-full ${config.badgeClass} flex items-center justify-center text-white text-xs font-bold shrink-0`}
                      >
                        {config.shortName}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">
                          {resource.title}
                          {!resource.enabled && (
                            <span className="ml-2 text-[10px] text-gray-500 bg-[#333] px-1.5 py-0.5 rounded">
                              已禁用
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-gray-500 truncate mt-0.5">
                          {[resource.size, resource.format, resource.note]
                            .filter(Boolean)
                            .join(" · ") || resource.url}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <a
                          href={resource.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-2 text-gray-500 hover:text-blue-400 transition-colors"
                          title="打开链接"
                        >
                          <ExternalLink size={16} />
                        </a>
                        <button
                          onClick={() => handleToggle(resource)}
                          className={`p-2 transition-colors ${
                            resource.enabled
                              ? "text-green-500 hover:text-green-400"
                              : "text-gray-600 hover:text-gray-400"
                          }`}
                          title={resource.enabled ? "点击禁用" : "点击启用"}
                        >
                          <Power size={16} />
                        </button>
                        <button
                          onClick={() => handleEdit(resource)}
                          className="p-2 text-gray-500 hover:text-white transition-colors"
                          title="编辑"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          onClick={() => handleDelete(resource)}
                          className="p-2 text-gray-500 hover:text-red-500 transition-colors"
                          title="删除"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
              {recentResources.map((resource) => {
                const config = PAN_BRAND_CONFIGS[resource.brand];
                return (
                  <button
                    key={resource.id}
                    onClick={() => handleSelectRecent(resource)}
                    className="w-full flex items-center gap-3 bg-[#222] hover:bg-[#2a2a2a] border border-[#333] hover:border-[#444] rounded-lg px-4 py-3 transition-colors text-left"
                  >
                    <span
                      className={`w-8 h-8 rounded-full ${config.badgeClass} flex items-center justify-center text-white text-xs font-bold shrink-0`}
                    >
                      {config.shortName}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">
                        {resource.movie_title || `豆瓣 ${resource.douban_id}`}
                        <span className="text-gray-500"> · {resource.title}</span>
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {config.name} · 更新于 {resource.updated_at?.slice(0, 10)}
                        {!resource.enabled && (
                          <span className="ml-1 text-gray-600">（已禁用）</span>
                        )}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
