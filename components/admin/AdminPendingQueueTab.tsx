"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Inbox, RefreshCw, Send, Trash2, ExternalLink } from "lucide-react";
import type { ToastState, ConfirmState } from "@/components/admin/types";
import { TaskProgressPanel } from "@/components/admin/TaskProgressPanel";

/**
 * 待转存数据 Tab：抓取入库但尚未转存（discovered/failed，含转存中）的
 * 条目管理页。支持搜索/分页、勾选批量或单个转存、删除（先删自己夸克
 * 网盘的转存目录再删本地记录，网盘失败保留记录可重试）。
 *
 * 进度展示复用短剧源 Tab 的轮询机制：POST 挂起期间读 sync_state 的
 * running_transfer 槽位里的实时进度（抓取租约独立，不阻塞转存操作）；
 * 删除走同步请求（串行删除较慢但量小，最多 50 条）。
 */

const POLL_INTERVAL_MS = 3_000;

interface QueueDrama {
  id: string;
  title: string;
  episode_count?: number;
  status: "discovered" | "failed" | "transferring" | string;
  publish_date?: string;
  source_share_url?: string;
  source_article_id: string;
  transfer_error?: string;
  transfer_attempts?: number;
  created_at: string;
}

interface RunningLease {
  task: string;
  started_at?: string;
  expires_at: string;
  progress?: {
    message: string;
    done?: number;
    total?: number;
  } | null;
}

interface AdminPendingQueueTabProps {
  onShowToast: (toast: ToastState) => void;
  onShowConfirm: (confirm: ConfirmState) => void;
}

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  discovered: { label: "待转存", className: "text-gray-300 bg-white/5 border-white/10" },
  transferring: { label: "转存中", className: "text-yellow-300 bg-yellow-400/10 border-yellow-400/20" },
  failed: { label: "失败", className: "text-red-400 bg-red-500/10 border-red-500/20" },
};

export function AdminPendingQueueTab({
  onShowToast,
  onShowConfirm,
}: AdminPendingQueueTabProps) {
  const [dramas, setDramas] = useState<QueueDrama[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "discovered" | "failed">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [runningLease, setRunningLease] = useState<RunningLease | null>(null);
  const [rangeInput, setRangeInput] = useState("");
  const lastPollAtRef = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const loadQueue = useCallback(async () => {
    lastPollAtRef.current = Date.now();
    setLoading(true);
    try {
      const params = new URLSearchParams({
        view: "queue",
        page: String(page),
        limit: "30",
      });
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const response = await fetch(`/api/admin/short-dramas?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (payload.code === 200 && payload.data) {
        setDramas(payload.data.dramas || []);
        setTotal(payload.data.total || 0);
        setPages(Math.max(1, Math.ceil((payload.data.total || 0) / (payload.data.limit || 30))));
      }
    } catch (error) {
      console.warn("读取待转存列表失败:", error);
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  const loadLease = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/short-dramas", { cache: "no-store" });
      const payload = await response.json();
      // 只读转存侧租约（running_transfer）：抓取租约独立，不影响转存操作
      const running = payload.data?.sync_state?.running_transfer;
      setRunningLease(
        running && new Date(running.expires_at).getTime() > Date.now() ? running : null
      );
    } catch {
      // 状态读取失败不影响列表
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // runningLease 即转存侧租约（转存/补齐/删除共用），非空表示转存类任务进行中
  const transferBusy = busyAction !== null || runningLease !== null;

  // 任务执行期间轮询：进度 + 完成后刷新列表
  useEffect(() => {
    if (!transferBusy) return;
    const timer = setInterval(async () => {
      if (Date.now() - lastPollAtRef.current < POLL_INTERVAL_MS - 100) return;
      lastPollAtRef.current = Date.now();
      await Promise.all([loadLease(), loadQueue()]);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [transferBusy, loadLease, loadQueue]);

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const actionable = dramas.filter((drama) => drama.status !== "transferring");
    const allSelected = actionable.length > 0 && actionable.every((drama) => selectedRef.current.has(drama.id));
    setSelected(allSelected ? new Set() : new Set(actionable.map((drama) => drama.id)));
  };

  const runTransfer = async (ids: string[] | null, label: string) => {
    setBusyAction("transfer");
    try {
      // 统一后台启动：几十部串行转存要几十分钟，同步请求必超时
      const body: Record<string, unknown> = { action: "transfer", background: true };
      if (ids) body.ids = ids;
      const response = await fetch("/api/admin/short-dramas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (response.ok && payload.data?.started) {
        onShowToast({
          message: ids
            ? `${label}已后台启动（${ids.length} 部），进度实时更新`
            : "转存任务已后台启动，进度实时更新",
          type: "info",
        });
      } else {
        onShowToast({ message: `${label}失败：${payload.message || "未知错误"}`, type: "error" });
      }
      setSelected(new Set());
    } catch (error) {
      onShowToast({
        message: `${label}失败：${error instanceof Error ? error.message : "网络异常"}`,
        type: "error",
      });
    } finally {
      setBusyAction(null);
      loadQueue();
      loadLease();
    }
  };

  /** 页码范围转存（后台启动）：1-20、5-8、单页 7 均可；叠加当前搜索/状态筛选 */
  const runRangeTransfer = () => {
    const normalized = rangeInput
      .trim()
      .replace(/．|。/g, ".")
      .replace(/，/g, ",")
      .replace(/[–—~－]|到/g, "-");
    const match = normalized.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) {
      onShowToast({ message: "范围格式：1-20、5-8 或单页 7", type: "error" });
      return;
    }
    const start = Math.max(1, Number(match[1]));
    const end = Math.max(start, Number(match[2] ?? match[1]));
    if (end - start + 1 > 50) {
      onShowToast({ message: "单次最多 50 页（约 1500 部），请分批", type: "error" });
      return;
    }

    const scopeLabel = `${start === end ? `第 ${start} 页` : `第 ${start}-${end} 页`}${
      search ? `（搜索「${search}」）` : ""
    }${statusFilter !== "all" ? `（${statusFilter === "failed" ? "仅失败" : "仅待转存"}）` : ""}`;
    onShowConfirm({
      title: `后台转存${scopeLabel}？`,
      message: `将按发布日期从新到旧，转存当前排序下 ${scopeLabel} 的全部待转存条目（每页 30 部，共 ${(end - start + 1) * 30} 部以内）。任务在后台串行执行，可关闭页面；容量不足时夸克会转存失败，失败条目保留可重试。`,
      confirmText: "启动转存",
      onConfirm: async () => {
        setBusyAction("transfer");
        try {
          const response = await fetch("/api/admin/short-dramas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "transfer",
              startPage: start,
              endPage: end,
              background: true,
              ...(search ? { search } : {}),
              ...(statusFilter !== "all" ? { status: statusFilter } : {}),
            }),
          });
          const payload = await response.json();
          if (response.ok && payload.data?.started) {
            onShowToast({ message: `范围转存已后台启动（${scopeLabel}），进度实时更新`, type: "info" });
          } else {
            onShowToast({ message: `启动失败：${payload.message || "未知错误"}`, type: "error" });
          }
        } catch (error) {
          onShowToast({
            message: `启动失败：${error instanceof Error ? error.message : "网络异常"}`,
            type: "error",
          });
        } finally {
          setBusyAction(null);
          loadLease();
        }
      },
    });
  };

  const confirmDelete = (ids: string[], label: string) => {
    onShowConfirm({
      title: `确认删除${label}`,
      message:
        `将删除 ${ids.length} 部短剧：同时删除自己夸克网盘里的转存目录（分享链接随之失效）和本地记录。网盘删除失败的条目会保留记录，可重试。此操作不可恢复。`,
      danger: true,
      onConfirm: async () => {
        setBusyAction("delete");
        try {
          const response = await fetch("/api/admin/short-dramas", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          const payload = await response.json();
          if (response.ok && payload.code === 200) {
            const data = payload.data || {};
            onShowToast({
              message: `删除完成：清理网盘 ${data.succeeded ?? 0} 部、仅删记录 ${data.local_only ?? 0} 部`,
              type: "success",
            });
          } else if (payload.code === 207) {
            const data = payload.data || {};
            const first = (data.failures || [])[0];
            onShowToast({
              message: `部分失败：成功 ${data.succeeded ?? 0}、失败 ${data.failed ?? 0}${
                first ? `（如「${first.title}」：${first.error}）` : ""
              }，失败条目已保留可重试`,
              type: "warning",
            });
          } else {
            onShowToast({ message: `删除失败：${payload.message || "未知错误"}`, type: "error" });
          }
          setSelected(new Set());
        } catch (error) {
          onShowToast({
            message: `删除失败：${error instanceof Error ? error.message : "网络异常"}`,
            type: "error",
          });
        } finally {
          setBusyAction(null);
          loadQueue();
        }
      },
    });
  };

  const selectedCount = selected.size;
  const hasLeaseBusy = runningLease !== null;
  const deleteDisabled = busyAction !== null || hasLeaseBusy;

  return (
    <div className="space-y-6">
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <h2 className="text-white font-bold text-lg flex items-center gap-2 mr-auto">
            <Inbox size={18} className="text-amber-400" />
            待转存数据（{total}）
          </h2>
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setPage(1);
                setSearch(searchInput.trim());
              }
            }}
            placeholder="搜索剧名…"
            className="w-44 bg-black/40 border border-[#333] rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-red-600"
          />
          <select
            value={statusFilter}
            onChange={(event) => {
              setPage(1);
              setStatusFilter(event.target.value as typeof statusFilter);
            }}
            className="bg-black/40 border border-[#333] rounded-lg px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-red-600"
          >
            <option value="all">全部状态</option>
            <option value="discovered">待转存</option>
            <option value="failed">失败</option>
          </select>
          <button
            onClick={loadQueue}
            disabled={loading}
            className="p-2 bg-[#2a2a2a] hover:bg-[#333] disabled:opacity-50 text-gray-300 rounded-lg transition-colors"
            title="刷新列表"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {(transferBusy || busyAction) && (
          <TaskProgressPanel
            message={
              hasLeaseBusy
                ? runningLease?.progress?.message || "任务执行中…"
                : busyAction === "delete"
                  ? "正在删除（清理网盘 + 本地记录）…"
                  : "正在提交转存任务…"
            }
            done={hasLeaseBusy ? runningLease?.progress?.done : undefined}
            total={hasLeaseBusy ? runningLease?.progress?.total : undefined}
            startedAt={hasLeaseBusy ? runningLease?.started_at : undefined}
          />
        )}

        {/* 批量操作条 */}
        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <label className="flex items-center gap-2 text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={
                dramas.filter((drama) => drama.status !== "transferring").length > 0 &&
                dramas
                  .filter((drama) => drama.status !== "transferring")
                  .every((drama) => selected.has(drama.id))
              }
              onChange={toggleAll}
              className="accent-red-600"
            />
            全选本页
          </label>
          <span className="text-gray-600">已选 {selectedCount} 部</span>
          <button
            onClick={() => runTransfer(Array.from(selected), "批量转存")}
            disabled={selectedCount === 0 || transferBusy}
            className="px-3 py-1.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
          >
            <Send size={12} />
            转存所选
          </button>
          <button
            onClick={() => confirmDelete(Array.from(selected), selectedCount > 1 ? `${selectedCount} 部` : "")}
            disabled={selectedCount === 0 || deleteDisabled}
            className="px-3 py-1.5 bg-red-600/90 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
          >
            <Trash2 size={12} />
            删除所选
          </button>
        </div>

        {/* 页码范围转存：与列表同分页，先转最新发布 */}
        <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
          <span className="text-gray-400">按页范围转存</span>
          <input
            value={rangeInput}
            onChange={(event) => setRangeInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") runRangeTransfer();
            }}
            placeholder="如 1-20"
            className="w-24 bg-black/40 border border-[#333] rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono placeholder:text-gray-600 focus:outline-none focus:border-sky-500"
          />
          <span className="text-xs text-gray-600">
            页（每页 30 部，按源站发布日期新→旧
            {search ? "，含当前搜索" : ""}
            {statusFilter !== "all" ? "，仅当前状态" : ""}）
          </span>
          <button
            onClick={runRangeTransfer}
            disabled={transferBusy}
            className="px-3 py-1.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
          >
            <Send size={12} />
            转存该范围
          </button>
        </div>

        {/* 列表 */}
        <div className="space-y-2">
          {dramas.map((drama) => {
            const badge = STATUS_BADGES[drama.status] || STATUS_BADGES.discovered;
            return (
              <div
                key={drama.id}
                className={`flex items-center gap-3 bg-black/20 border rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  selected.has(drama.id) ? "border-red-600/60 bg-red-500/5" : "border-[#2a2a2a]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(drama.id)}
                  onChange={() => toggleOne(drama.id)}
                  disabled={drama.status === "transferring"}
                  className="accent-red-600 shrink-0 disabled:opacity-30"
                />
                <span
                  className={`shrink-0 px-2 py-0.5 rounded border text-[11px] font-medium ${badge.className}`}
                >
                  {badge.label}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-gray-200 truncate" title={drama.title}>
                    {drama.title}
                    {drama.episode_count ? (
                      <span className="text-gray-500">（{drama.episode_count}集）</span>
                    ) : (
                      ""
                    )}
                  </span>
                  <span className="block mt-0.5 text-[11px] text-gray-600 flex flex-wrap gap-x-3">
                    <span>发布 {drama.publish_date || "未知"}</span>
                    <span>抓取 {drama.created_at.slice(0, 10)}</span>
                    {drama.transfer_attempts ? <span>已试 {drama.transfer_attempts} 次</span> : null}
                    {drama.transfer_error && (
                      <span className="text-red-400/70 truncate max-w-[50%]" title={drama.transfer_error}>
                        {drama.transfer_error}
                      </span>
                    )}
                  </span>
                </span>
                {drama.source_share_url && (
                  <a
                    href={drama.source_share_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 p-1.5 text-gray-500 hover:text-sky-400 transition-colors"
                    title="查看源站分享链接"
                  >
                    <ExternalLink size={14} />
                  </a>
                )}
                <button
                  onClick={() => runTransfer([drama.id], "转存")}
                  disabled={drama.status === "transferring" || transferBusy}
                  className="shrink-0 px-2.5 py-1 bg-sky-600/90 hover:bg-sky-700 disabled:opacity-40 text-white rounded text-xs font-medium transition-colors"
                >
                  转存
                </button>
                <button
                  onClick={() => confirmDelete([drama.id], "")}
                  disabled={deleteDisabled}
                  className="shrink-0 px-2.5 py-1 bg-[#2a2a2a] hover:bg-red-600 disabled:opacity-40 text-gray-300 hover:text-white rounded text-xs font-medium transition-colors"
                >
                  删除
                </button>
              </div>
            );
          })}
          {dramas.length === 0 && !loading && (
            <p className="text-sm text-gray-600 py-8 text-center">
              没有待转存的数据。先到「短剧源」Tab 跑一轮抓取。
            </p>
          )}
        </div>

        {/* 分页 */}
        {pages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-3 text-sm">
            <button
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 bg-[#2a2a2a] hover:bg-[#333] disabled:opacity-40 text-gray-300 rounded-lg transition-colors"
            >
              上一页
            </button>
            <span className="text-gray-500">
              {page} / {pages}
            </span>
            <button
              onClick={() => setPage((prev) => Math.min(pages, prev + 1))}
              disabled={page >= pages}
              className="px-3 py-1.5 bg-[#2a2a2a] hover:bg-[#333] disabled:opacity-40 text-gray-300 rounded-lg transition-colors"
            >
              下一页
            </button>
          </div>
        )}
        <p className="mt-4 text-xs text-gray-600">
          转存按队列串行执行（防风控），可随时勾选新条目追加；删除会先清自己网盘的转存目录再删本地记录。转存中的条目不可勾选删除。
        </p>
      </section>
    </div>
  );
}
