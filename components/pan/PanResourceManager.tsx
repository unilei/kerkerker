"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Plus,
  Trash2,
  Edit2,
  X,
  Loader2,
  ExternalLink,
  Power,
  ClipboardPaste,
  Sparkles,
  CloudDownload,
  Search,
} from "lucide-react";
import {
  PAN_BRANDS,
  PAN_BRAND_CONFIGS,
  type PanBrand,
  type PanResource,
} from "@/types/pan-resource";
import { parsePanText } from "@/lib/pan/parse";
import { BrandBadge } from "./BrandBadge";
import type { ToastState, ConfirmState } from "@/components/admin/types";

// 目标影片（豆瓣数据已就位，无需再搜索）
export interface PanManagerMovie {
  douban_id: string;
  title: string;
  internal_id?: number;
}

interface PanResourceManagerProps {
  movie: PanManagerMovie;
  onShowToast: (toast: ToastState) => void;
  onShowConfirm: (confirm: ConfirmState) => void;
  /** 资源发生变更（入库/编辑/启停/删除）后回调，供外层刷新展示 */
  onChanged?: () => void;
}

// 待录入/编辑的草稿行
interface DraftRow {
  key: string;
  brand: PanBrand | "";
  title: string;
  url: string;
  size: string;
  format: string;
  code: string;
  note: string;
  editingId?: string; // 有值时为编辑已有资源（PUT）
}

const inputClass =
  "w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500/60 transition-colors";

// kkpans 拉取结果（/api/kkpan/search 归一化后的条目）
interface KkpanItem {
  brand: PanBrand;
  title: string;
  url: string;
  code?: string;
  size?: string;
  format?: string;
  updatedAt?: string;
}

function emptyRow(): DraftRow {
  return {
    key: Math.random().toString(36).slice(2),
    brand: "",
    title: "",
    url: "",
    size: "",
    format: "",
    code: "",
    note: "",
  };
}

let rowSeq = 0;
function nextKey() {
  return `row-${Date.now()}-${rowSeq++}`;
}

/**
 * 网盘资源管理面板（后台 Tab 与详情页内嵌共用）
 *
 * 智能粘贴 → 自动识别品牌/大小/格式/提取码 → 预览表格修正 → 批量入库，
 * 并提供该片已有资源的编辑 / 启停 / 删除。
 */
export function PanResourceManager({
  movie,
  onShowToast,
  onShowConfirm,
  onChanged,
}: PanResourceManagerProps) {
  const [resources, setResources] = useState<PanResource[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [pasteText, setPasteText] = useState("");
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 从 kkpans 拉取（仅转存成功的资源）
  const [kkpanKeyword, setKkpanKeyword] = useState(movie.title);
  const [kkpanResults, setKkpanResults] = useState<KkpanItem[]>([]);
  const [kkpanChecked, setKkpanChecked] = useState<Set<string>>(new Set());
  const [kkpanLoading, setKkpanLoading] = useState(false);

  // 切换影片时重置拉取状态，关键词预填当前片名
  useEffect(() => {
    setKkpanKeyword(movie.title);
    setKkpanResults([]);
    setKkpanChecked(new Set());
  }, [movie.douban_id, movie.title]);

  // 加载该片全部资源（含禁用，需管理员会话）
  const loadResources = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/pan-resources?all=true&douban_id=${encodeURIComponent(movie.douban_id)}`
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
      setIsLoading(false);
    }
  }, [movie.douban_id, onShowToast]);

  useEffect(() => {
    loadResources();
  }, [loadResources]);

  // 智能粘贴解析
  const handleParse = () => {
    if (!pasteText.trim()) {
      onShowToast({ message: "请先粘贴资源文本", type: "warning" });
      return;
    }
    const items = parsePanText(pasteText, movie.title);
    if (items.length === 0) {
      onShowToast({
        message: "未从文本中解析出分享链接（需包含 http/https 链接）",
        type: "warning",
      });
      return;
    }
    const rows: DraftRow[] = items.map((item) => ({
      key: nextKey(),
      brand: item.brand,
      title: item.title,
      url: item.url,
      size: item.size || "",
      format: item.format || "",
      code: item.code || "",
      note: "",
    }));
    setDrafts((prev) => [...prev, ...rows]);
    setPasteText("");
    const unrecognized = rows.filter((r) => !r.brand).length;
    onShowToast({
      message: `解析出 ${rows.length} 条资源${unrecognized > 0 ? `，其中 ${unrecognized} 条需手动选择品牌` : ""}`,
      type: "success",
    });
  };

  const updateDraft = (key: string, patch: Partial<DraftRow>) => {
    setDrafts((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const removeDraft = (key: string) => {
    setDrafts((prev) => prev.filter((r) => r.key !== key));
  };

  const addManualRow = () => {
    setDrafts((prev) => [...prev, emptyRow()]);
  };

  const clearDrafts = () => {
    setDrafts([]);
  };

  // 搜索 kkpans 公开目录（服务端代理，仅转存成功资源）
  const handleKkpanSearch = async () => {
    const keyword = kkpanKeyword.trim();
    if (!keyword) {
      onShowToast({ message: "请输入搜索关键词", type: "warning" });
      return;
    }
    setKkpanLoading(true);
    try {
      const response = await fetch(
        `/api/kkpan/search?keyword=${encodeURIComponent(keyword)}`
      );
      const result = await response.json();
      if (result.code !== 200) {
        throw new Error(result.message || "kkpans 拉取失败");
      }
      const items: KkpanItem[] = result.data?.items || [];
      setKkpanResults(items);
      setKkpanChecked(new Set(items.map((item) => item.url)));
      onShowToast({
        message:
          items.length > 0
            ? `找到 ${items.length} 条转存成功的资源`
            : "kkpans 上未找到相关资源",
        type: items.length > 0 ? "success" : "info",
      });
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "kkpans 拉取失败",
        type: "error",
      });
      setKkpanResults([]);
    } finally {
      setKkpanLoading(false);
    }
  };

  // 该链接是否已存在（已有资源或待入库草稿中）
  const isUrlExists = useCallback(
    (url: string) =>
      resources.some((r) => r.url === url) || drafts.some((d) => d.url === url),
    [resources, drafts]
  );

  // 勾选/取消勾选
  const toggleKkpanCheck = (url: string) => {
    setKkpanChecked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else {
        next.add(url);
      }
      return next;
    });
  };

  // 勾选项导入待入库草稿（跳过已存在的链接）
  const importKkpanChecked = () => {
    const importable = kkpanResults.filter(
      (item) => kkpanChecked.has(item.url) && !isUrlExists(item.url)
    );
    if (importable.length === 0) {
      onShowToast({ message: "没有可导入的条目", type: "warning" });
      return;
    }
    const rows: DraftRow[] = importable.map((item) => ({
      key: nextKey(),
      brand: item.brand,
      title: item.title,
      url: item.url,
      size: item.size || "",
      format: item.format || "",
      code: item.code || "",
      note: "",
    }));
    setDrafts((prev) => [...prev, ...rows]);
    setKkpanResults([]);
    setKkpanChecked(new Set());
    onShowToast({
      message: `已导入 ${rows.length} 条到待入库列表，确认后点「全部入库」`,
      type: "success",
    });
  };

  // 校验草稿行，返回首个错误信息
  const validateDrafts = (): string | null => {
    for (let i = 0; i < drafts.length; i++) {
      const row = drafts[i];
      const label = `第 ${i + 1} 行`;
      if (!row.brand) return `${label}：请选择网盘品牌`;
      if (!row.title.trim()) return `${label}：请填写资源名称`;
      if (!row.url.trim()) return `${label}：请填写分享链接`;
      if (!/^https?:\/\//.test(row.url.trim()))
        return `${label}：链接需以 http/https 开头`;
    }
    return null;
  };

  // 批量入库（新增 POST / 编辑 PUT，逐条提交）
  const handleSubmitAll = async () => {
    if (drafts.length === 0) return;

    const error = validateDrafts();
    if (error) {
      onShowToast({ message: error, type: "warning" });
      return;
    }

    setIsSubmitting(true);
    let success = 0;
    let failed = 0;
    try {
      for (const row of drafts) {
        const payload = {
          douban_id: movie.douban_id,
          internal_id: movie.internal_id,
          movie_title: movie.title,
          brand: row.brand as PanBrand,
          title: row.title.trim(),
          url: row.url.trim(),
          size: row.size.trim() || undefined,
          format: row.format.trim() || undefined,
          code: row.code.trim() || undefined,
          note: row.note.trim() || undefined,
        };
        try {
          const response = await fetch("/api/pan-resources", {
            method: row.editingId ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              row.editingId ? { id: row.editingId, ...payload } : payload
            ),
          });
          const result = await response.json();
          if (result.code === 200) {
            success++;
          } else {
            failed++;
            console.error("保存网盘资源失败:", result.message);
          }
        } catch {
          failed++;
        }
      }

      if (success > 0) {
        onShowToast({
          message: `成功保存 ${success} 条资源${failed > 0 ? `，${failed} 条失败` : ""}`,
          type: failed > 0 ? "warning" : "success",
        });
      } else {
        onShowToast({ message: "保存失败，请检查链接格式", type: "error" });
      }

      if (success > 0) {
        setDrafts([]);
        loadResources();
        onChanged?.();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // 编辑已有资源 → 载入草稿区
  const handleEdit = (resource: PanResource) => {
    setDrafts([
      {
        key: nextKey(),
        brand: resource.brand,
        title: resource.title,
        url: resource.url,
        size: resource.size || "",
        format: resource.format || "",
        code: resource.code || "",
        note: resource.note || "",
        editingId: resource.id,
      },
    ]);
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
      loadResources();
      onChanged?.();
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
          if (drafts.length === 1 && drafts[0].editingId === resource.id) {
            setDrafts([]);
          }
          loadResources();
          onChanged?.();
        } catch (error) {
          onShowToast({
            message: error instanceof Error ? error.message : "删除失败",
            type: "error",
          });
        }
      },
    });
  };

  const editingCount = drafts.filter((r) => r.editingId).length;

  return (
    <div className="space-y-5">
      {/* 从 kkpans 拉取 */}
      <div className="bg-black/20 border border-white/10 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm text-gray-300 font-medium flex items-center gap-2">
            <CloudDownload size={14} className="text-red-400" />
            从 kkpans 拉取
          </h4>
          <span className="text-xs text-gray-500">
            仅拉取转存成功的资源（分享链接有效）
          </span>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={kkpanKeyword}
            onChange={(e) => setKkpanKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleKkpanSearch()}
            placeholder="输入片名搜索 kkpans 资源库"
            className={inputClass}
          />
          <button
            onClick={handleKkpanSearch}
            disabled={kkpanLoading}
            className="px-4 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
          >
            {kkpanLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} />
            )}
            搜索
          </button>
        </div>

        {/* 拉取结果 */}
        {kkpanResults.length > 0 && (
          <div className="mt-3 space-y-2 max-h-80 overflow-y-auto">
            {kkpanResults.map((item) => {
              const config = PAN_BRAND_CONFIGS[item.brand];
              const exists = isUrlExists(item.url);
              const checked = kkpanChecked.has(item.url);
              return (
                <label
                  key={item.url}
                  className={`flex items-center gap-3 bg-black/30 border rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                    exists
                      ? "border-white/5 opacity-50 cursor-not-allowed"
                      : checked
                        ? "border-red-500/50"
                        : "border-white/10 hover:border-white/25"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked && !exists}
                    disabled={exists}
                    onChange={() => toggleKkpanCheck(item.url)}
                    className="accent-red-600 shrink-0"
                  />
                  <BrandBadge brand={item.brand} size="sm" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-white truncate">
                      {item.title}
                    </span>
                    <span className="block text-xs text-gray-500 truncate mt-0.5">
                      {[config.name, item.size, item.format, item.code ? `提取码 ${item.code}` : null, item.updatedAt]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {exists && (
                    <span className="text-[10px] text-gray-400 bg-white/10 px-1.5 py-0.5 rounded shrink-0">
                      已存在
                    </span>
                  )}
                </label>
              );
            })}
            <button
              onClick={importKkpanChecked}
              className="w-full py-2 bg-white/10 hover:bg-white/20 text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <Plus size={14} />
              导入所选（
              {
                kkpanResults.filter(
                  (item) => kkpanChecked.has(item.url) && !isUrlExists(item.url)
                ).length
              }{" "}
              条）
            </button>
          </div>
        )}
      </div>

      {/* 智能粘贴 */}
      <div className="bg-black/20 border border-white/10 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm text-gray-300 font-medium flex items-center gap-2">
            <Sparkles size={14} className="text-red-400" />
            智能粘贴
          </h4>
          <span className="text-xs text-gray-500">
            支持整段复制资源群文本，自动识别品牌 / 大小 / 格式 / 提取码
          </span>
        </div>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          rows={3}
          placeholder={
            "示例：\n【夸克网盘】大濛.2025.4K.HDR.中字 2.3GB MP4\n链接：https://pan.quark.cn/s/xxxxxx 提取码：abcd"
          }
          className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500/60 transition-colors resize-y font-mono"
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleParse}
            className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5"
          >
            <ClipboardPaste size={14} />
            解析文本
          </button>
          <button
            onClick={addManualRow}
            className="px-4 py-1.5 bg-white/10 hover:bg-white/20 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5"
          >
            <Plus size={14} />
            手动添加一行
          </button>
        </div>
      </div>

      {/* 待入库草稿表格 */}
      {drafts.length > 0 && (
        <div className="bg-black/20 border border-white/10 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm text-gray-300 font-medium flex items-center gap-2">
              {editingCount > 0 ? (
                <>
                  <Edit2 size={14} className="text-red-400" />
                  编辑资源
                </>
              ) : (
                <>
                  <Plus size={14} className="text-red-400" />
                  待入库（{drafts.length} 条）
                </>
              )}
            </h4>
            <button
              onClick={clearDrafts}
              className="text-xs text-gray-500 hover:text-white transition-colors"
            >
              清空
            </button>
          </div>

          <div className="space-y-2">
            {drafts.map((row, index) => (
              <div
                key={row.key}
                className="bg-black/30 border border-white/10 rounded-lg p-3 space-y-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-500 shrink-0">
                    #{index + 1}
                  </span>
                  {/* 品牌选择 */}
                  <div className="flex flex-wrap gap-1.5">
                    {PAN_BRANDS.map((brand) => {
                      const config = PAN_BRAND_CONFIGS[brand];
                      const active = row.brand === brand;
                      return (
                        <button
                          key={brand}
                          type="button"
                          onClick={() => updateDraft(row.key, { brand })}
                          className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border transition-colors ${
                            active
                              ? "border-red-500 bg-red-500/15 text-white"
                              : "border-white/10 bg-black/30 text-gray-400 hover:text-white hover:border-white/30"
                          }`}
                        >
                          <BrandBadge brand={brand} size="sm" />
                          <span className="text-xs">{config.name}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => removeDraft(row.key)}
                    className="ml-auto p-1.5 text-gray-500 hover:text-red-400 transition-colors shrink-0"
                    title="移除此行"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={row.title}
                    onChange={(e) =>
                      updateDraft(row.key, { title: e.target.value })
                    }
                    placeholder="资源名称，如：大濛.2025.4K.中字"
                    className={`${inputClass} md:col-span-2`}
                  />
                  <input
                    type="text"
                    value={row.url}
                    onChange={(e) =>
                      updateDraft(row.key, { url: e.target.value })
                    }
                    placeholder="分享链接 https://..."
                    className={`${inputClass} md:col-span-2 font-mono text-xs`}
                  />
                  <input
                    type="text"
                    value={row.size}
                    onChange={(e) =>
                      updateDraft(row.key, { size: e.target.value })
                    }
                    placeholder="大小，如 2.3GB"
                    className={inputClass}
                  />
                  <input
                    type="text"
                    value={row.format}
                    onChange={(e) =>
                      updateDraft(row.key, { format: e.target.value })
                    }
                    placeholder="格式，如 MP4"
                    className={inputClass}
                  />
                  <input
                    type="text"
                    value={row.code}
                    onChange={(e) =>
                      updateDraft(row.key, { code: e.target.value })
                    }
                    placeholder="提取码（无则留空）"
                    className={inputClass}
                  />
                  <input
                    type="text"
                    value={row.note}
                    onChange={(e) =>
                      updateDraft(row.key, { note: e.target.value })
                    }
                    placeholder="备注（可选）"
                    className={inputClass}
                  />
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={handleSubmitAll}
            disabled={isSubmitting}
            className="mt-3 w-full py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Plus size={16} />
            )}
            {editingCount > 0 ? "保存修改" : `全部入库（${drafts.length} 条）`}
          </button>
        </div>
      )}

      {/* 已有资源列表 */}
      <div>
        <h4 className="text-sm text-gray-400 font-medium mb-3">
          该片资源（{resources.length}）
        </h4>
        {isLoading ? (
          <div className="py-8 flex justify-center">
            <Loader2 size={24} className="animate-spin text-gray-600" />
          </div>
        ) : resources.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            暂无资源，粘贴文本或手动添加
          </p>
        ) : (
          <div className="space-y-2">
            {resources.map((resource) => {
              const config = PAN_BRAND_CONFIGS[resource.brand];
              return (
                <div
                  key={resource.id}
                  className={`flex items-center gap-3 bg-black/25 border rounded-lg px-4 py-3 transition-colors ${
                    drafts.length === 1 && drafts[0].editingId === resource.id
                      ? "border-red-500/60"
                      : "border-white/10"
                  } ${!resource.enabled ? "opacity-50" : ""}`}
                >
                  <BrandBadge brand={resource.brand} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">
                      {resource.title}
                      {!resource.enabled && (
                        <span className="ml-2 text-[10px] text-gray-500 bg-white/10 px-1.5 py-0.5 rounded">
                          已禁用
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                      {[
                        config.name,
                        resource.size,
                        resource.format,
                        resource.code ? `提取码 ${resource.code}` : null,
                        resource.note,
                      ]
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
  );
}
