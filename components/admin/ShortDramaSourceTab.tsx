"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Database,
  KeyRound,
  RefreshCw,
  Send,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Trash2,
  XCircle as XCircleIcon,
} from "lucide-react";
import type { ToastState, ConfirmState } from "@/components/admin/types";
import { TaskProgressPanel } from "@/components/admin/TaskProgressPanel";

/**
 * KKPan 同步 Tab（短剧数据源管理）
 *
 * 短剧条目与分享链接来自 kkpan 公开 API，封面/简介/metadata
 * 三件套由元数据同步从 kkpan 分享目录采集（封面 R2 镜像）。
 * 四块能力：
 *  1. 数据源状态：KKPAN_API_BASE_URL 配置状态 + 夸克凭证管理
 *  2. 条目同步：全量拉取 + 下线收敛，快速同步请求
 *  3. 元数据同步：小批（后台启动）+ 全量（后台跑完整个队列），实时进度
 *  4. 台账：published/offline 统计 + 最近条目（可删本地记录）
 *
 * 任务执行期间每 3s 轮询 GET 读取 sync_state 的 running_sync 槽位实时
 * 进度；curl 等外部触发的任务同样能看到。
 */

const PROGRESS_POLL_INTERVAL_MS = 3_000;
const METADATA_BATCH = 20;

interface CredentialView {
  platform: string;
  account_label?: string;
  cookie_masked: string;
  is_valid: boolean;
  last_validated_at?: string;
}

interface TaskProgress {
  stage: string;
  message: string;
  done?: number;
  total?: number;
  updated_at: string;
}

interface TaskLease {
  task: string;
  started_at: string;
  expires_at: string;
  progress?: TaskProgress | null;
}

interface SyncState {
  last_entries_sync_at?: string;
  last_entries_sync_stats?: Record<string, unknown>;
  last_metadata_sync_at?: string;
  last_metadata_sync_stats?: Record<string, unknown>;
  running_sync?: TaskLease | null;
}

interface DramaStats {
  total: number;
  by_status: Record<string, number>;
}

interface RecentDrama {
  id: string;
  title: string;
  status: string;
  episode_count?: number;
  updated_at: string;
}

interface AdminShortDramasTabProps {
  onShowToast: (toast: ToastState) => void;
  onShowConfirm: (confirm: ConfirmState) => void;
}

export function AdminShortDramasTab({ onShowToast, onShowConfirm }: AdminShortDramasTabProps) {
  const [cookieInput, setCookieInput] = useState("");
  const [credential, setCredential] = useState<CredentialView | null>(null);
  const [savingCredential, setSavingCredential] = useState(false);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [stats, setStats] = useState<DramaStats | null>(null);
  const [recent, setRecent] = useState<RecentDrama[]>([]);
  const [kkpanApiReady, setKkpanApiReady] = useState(false);
  const [coverMirrorReady, setCoverMirrorReady] = useState(false);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  /**
   * background 启动后的「等租约」窗口：启动响应先于任务租约落库返回，
   * 若只靠启动后那一次 loadState，可能读不到租约导致轮询永远不启动、
   * 进度面板不出现。记录启动的任务与 60s 截止时间，强制进入轮询，
   * 租约一出现即接管，超时未出现自动退出窗口。
   */
  const [pendingBackground, setPendingBackground] = useState<{
    action: string;
    until: number;
  } | null>(null);
  const lastLoadStateAtRef = useRef(0);

  const loadState = useCallback(async () => {
    lastLoadStateAtRef.current = Date.now();
    try {
      const [credRes, syncRes] = await Promise.all([
        fetch("/api/admin/cloud-credentials", { cache: "no-store" }),
        fetch("/api/admin/short-dramas", { cache: "no-store" }),
      ]);
      const credPayload = await credRes.json();
      if (credPayload.code === 200) setCredential(credPayload.data?.credential ?? null);
      const syncPayload = await syncRes.json();
      if (syncPayload.code === 200 && syncPayload.data) {
        setSyncState(syncPayload.data.sync_state);
        setStats(syncPayload.data.stats);
        setRecent(syncPayload.data.recent_dramas || []);
        setKkpanApiReady(!!syncPayload.data.kkpan_api_ready);
        setCoverMirrorReady(!!syncPayload.data.cover_mirror_ready);
      }
    } catch (error) {
      console.warn("读取同步状态失败:", error);
    }
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  // 未过期的运行租约（本页触发的或 curl 等外部触发的任务都算）
  const syncLease =
    syncState?.running_sync &&
    new Date(syncState.running_sync.expires_at).getTime() > Date.now()
      ? syncState.running_sync
      : null;
  const isPolling = syncLease !== null || runningAction !== null || pendingBackground !== null;

  // 任务执行期间轮询同步状态，驱动实时进度展示
  useEffect(() => {
    if (!isPolling) return;
    const timer = setInterval(() => {
      if (Date.now() - lastLoadStateAtRef.current < PROGRESS_POLL_INTERVAL_MS - 100) return;
      lastLoadStateAtRef.current = Date.now();
      loadState();
    }, PROGRESS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isPolling, loadState]);

  // 等租约窗口超时自动退出（任务秒退/未启动时不至于永久轮询）
  useEffect(() => {
    if (!pendingBackground) return;
    const remaining = pendingBackground.until - Date.now();
    if (remaining <= 0) {
      setPendingBackground(null);
      return;
    }
    const timer = setTimeout(() => setPendingBackground(null), remaining);
    return () => clearTimeout(timer);
  }, [pendingBackground]);

  // 任一任务租约出现即接管展示，退出等待窗口
  useEffect(() => {
    if (pendingBackground && syncLease !== null) {
      setPendingBackground(null);
    }
  }, [pendingBackground, syncLease]);

  const saveCredential = async () => {
    if (!cookieInput.trim()) {
      onShowToast({ message: "请先粘贴夸克 cookie", type: "error" });
      return;
    }
    setSavingCredential(true);
    try {
      const response = await fetch("/api/admin/cloud-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "quark", cookie: cookieInput.trim() }),
      });
      const payload = await response.json();
      if (payload.code === 200) {
        setCredential(payload.data?.credential ?? null);
        setCookieInput("");
        onShowToast({ message: "凭证已保存并通过夸克验证", type: "success" });
      } else {
        onShowToast({ message: payload.message || "凭证保存失败", type: "error" });
      }
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "凭证保存失败",
        type: "error",
      });
    } finally {
      setSavingCredential(false);
    }
  };

  const runAction = async (action: string, label: string, body: Record<string, unknown> = {}) => {
    setRunningAction(action);
    try {
      const response = await fetch("/api/admin/short-dramas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const payload = await response.json();
      if (response.ok) {
        // background 启动模式：请求立即返回，任务在后台跑（进度面板接管展示）
        if (payload.data?.started) {
          // 进入等租约窗口：保证下一次轮询无论租约是否已落库都能接上
          setPendingBackground({ action, until: Date.now() + 60_000 });
          onShowToast({ message: `${label}已在后台启动，下方进度实时更新`, type: "info" });
        } else {
          onShowToast({ message: `${label}完成：${summarize(action, payload.data)}`, type: "success" });
        }
      } else {
        onShowToast({ message: `${label}失败：${payload.message || "未知错误"}`, type: "error" });
      }
    } catch (error) {
      onShowToast({
        message: `${label}失败：${error instanceof Error ? error.message : "网络异常"}`,
        type: "error",
      });
    } finally {
      setRunningAction(null);
      loadState();
    }
  };

  /** 取消运行中/残留的元数据同步：活任务优雅停（当前条目完成后），死任务清残留 */
  const cancelTask = async () => {
    try {
      const response = await fetch("/api/admin/short-dramas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "task-cancel" }),
      });
      const payload = await response.json();
      onShowToast({
        message: payload.message || (payload.code === 200 ? "已取消" : "无法取消"),
        type: payload.code === 200 ? "success" : "error",
      });
      loadState();
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "网络异常",
        type: "error",
      });
    }
  };

  /** 清空短剧库并复位同步水位（危险，一次性） */
  const purgeLegacy = () => {
    onShowConfirm({
      title: "清空短剧库？",
      message:
        "将删除本地全部短剧记录（含旧 duanjugou 数据）并复位同步水位与统计，标签分组映射保留。此操作不可恢复；kkpan 侧数据不受影响，清库后重新「全量同步」即可重建。",
      danger: true,
      confirmText: "确认清空",
      onConfirm: async () => {
        await runAction("purge-legacy", "清空短剧库");
      },
    });
  };

  /** 条目同步（幂等全量：拉取 → 按剧归一入库 → 下线收敛） */
  const runEntriesSync = () => {
    onShowConfirm({
      title: "同步条目？",
      message:
        "将从 kkpan 公开 API 拉取全部短剧分类下的公开夸克资源，按剧名归一入库（同剧保留集数最新的一条），并把 kkpan 已消失的条目置为下线。数据量大时耗时约 1-2 分钟，请耐心等待。",
      confirmText: "开始同步",
      onConfirm: async () => {
        await runAction("entries-sync", "条目同步");
      },
    });
  };

  /** 全量补齐元数据：后台一次跑完整个补齐队列 + 确认弹窗说明耗时与终结标记 */
  const startMetadataBackfill = () => {
    onShowConfirm({
      title: "启动全量补齐元数据？",
      message:
        "将对所有「已发布但缺封面/简介/metadata」的条目重新列 kkpan 夸克网盘目录补齐（每条约 10-30 秒，队列可能上百条，将在后台执行，可关闭页面）。最近更新的先补，补完即出现在首页前列。转存目录里本来就没有的部件会记为「源缺失」，之后不再重复尝试。",
      confirmText: "启动全量补齐",
      onConfirm: async () => {
        await runAction("metadata-sync", "全量补齐元数据", { background: true });
      },
    });
  };

  const deleteDrama = (drama: RecentDrama) => {
    onShowConfirm({
      title: "删除本地记录？",
      message: `将删除「${drama.title}」的本地记录（纯本地操作，不影响 kkpan 数据与网盘文件）。若 kkpan 侧仍在，下次全量同步会重新入库。`,
      danger: true,
      confirmText: "确认删除",
      onConfirm: async () => {
        setRunningAction("delete");
        try {
          const response = await fetch("/api/admin/short-dramas", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: [drama.id] }),
          });
          const payload = await response.json();
          if (response.ok && payload.code === 200) {
            onShowToast({ message: "已删除本地记录", type: "success" });
          } else {
            onShowToast({ message: `删除失败：${payload.message || "未知错误"}`, type: "error" });
          }
        } catch (error) {
          onShowToast({
            message: error instanceof Error ? error.message : "网络异常",
            type: "error",
          });
        } finally {
          setRunningAction(null);
          loadState();
        }
      },
    });
  };

  const syncProgress = syncLease?.progress ?? null;
  const sectionBusy = runningAction !== null || syncLease !== null || pendingBackground !== null;

  return (
    <div className="space-y-8">
      {/* 数据源状态 */}
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <Database size={18} className="text-sky-400" />
          数据源（kkpan）
        </h2>
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          {kkpanApiReady ? (
            <CheckCircle2 size={16} className="text-green-400" />
          ) : (
            <XCircle size={16} className="text-red-400" />
          )}
          <span className={kkpanApiReady ? "text-green-400" : "text-red-400"}>
            {kkpanApiReady ? "已配置 KKPAN_API_BASE_URL" : "未配置 KKPAN_API_BASE_URL（条目同步不可用）"}
          </span>
        </div>
        {!coverMirrorReady && (
          <p className="mb-4 text-xs text-yellow-400/90 flex items-center gap-2">
            <AlertTriangle size={13} />
            R2 封面镜像未配置（CLOUDFLARE_R2_* 环境变量缺失）：元数据同步仍可用，但封面不会镜像
          </p>
        )}

        <h3 className="text-gray-300 font-medium mb-3 flex items-center gap-2 text-sm">
          <KeyRound size={14} className="text-orange-400" />
          夸克网盘凭证（kkpan 同账号，元数据同步用）
        </h3>
        {credential ? (
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            {credential.is_valid ? (
              <CheckCircle2 size={16} className="text-green-400" />
            ) : (
              <XCircle size={16} className="text-red-400" />
            )}
            <span className={credential.is_valid ? "text-green-400" : "text-red-400"}>
              {credential.is_valid ? "有效" : "已失效"}
            </span>
            <span className="text-gray-400">
              账号：{credential.account_label || "未知"}
            </span>
            <span className="text-gray-600 font-mono">{credential.cookie_masked}</span>
            {credential.last_validated_at && (
              <span className="text-gray-600">
                校验于 {credential.last_validated_at.slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>
        ) : (
          <p className="mb-4 text-sm text-gray-500 flex items-center gap-2">
            <AlertTriangle size={14} className="text-yellow-400" />
            尚未配置凭证：请在浏览器登录 pan.quark.cn 后（kkpan 转存用的同一账号），从 DevTools → Network 任意请求的 Request Headers 复制完整 cookie 粘贴到下方（需含 __pus/__kps/__puus 等登录态字段）
          </p>
        )}
        <textarea
          value={cookieInput}
          onChange={(event) => setCookieInput(event.target.value)}
          rows={3}
          placeholder="__kps=…; __pus=…; __puus=…; …（浏览器 cookie 整行粘贴）"
          className="w-full bg-black/40 border border-[#333] rounded-lg px-3 py-2 text-sm text-gray-200 font-mono placeholder:text-gray-600 focus:outline-none focus:border-red-600"
        />
        <button
          onClick={saveCredential}
          disabled={savingCredential}
          className="mt-3 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {savingCredential ? "验证中…" : "验证并保存凭证"}
        </button>
        <p className="mt-2 text-xs text-gray-600">
          凭证以 AES-256-GCM 加密落库（密钥取 CREDENTIAL_ENCRYPTION_KEY / ADMIN_SESSION_SECRET），任何界面只回显掩码。
        </p>
      </section>

      {/* 条目同步 */}
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <RefreshCw size={18} className="text-emerald-400" />
          条目同步（kkpan → 本地）
        </h2>
        <div className="flex flex-wrap gap-3 mb-4">
          <button
            onClick={runEntriesSync}
            disabled={sectionBusy}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <RefreshCw size={14} className={runningAction === "entries-sync" ? "animate-spin" : ""} />
            同步条目（全量 + 下线收敛）
          </button>
        </div>
        {runningAction === "entries-sync" && (
          <TaskProgressPanel message="正在从 kkpan 同步条目…" startedAt={undefined} />
        )}
        <p className="text-xs text-gray-600">
          条目同步调用 kkpan 公开 API 拉取「短剧」分类的全部公开夸克资源，按剧名归一去重后入库（分享链接以
          kkpan 的自有链接为准），并把 kkpan 已消失的条目置为下线。幂等可重复执行，也可用 curl 挂 crontab：
          <code className="ml-1 px-1.5 py-0.5 bg-black/40 rounded text-[11px] text-gray-400">
            curl -X POST -b admin_session=… -H &apos;Content-Type: application/json&apos; -d &apos;{"{"}&quot;action&quot;:&quot;entries-sync&quot;{"}"}&apos; /api/admin/short-dramas
          </code>
        </p>
        {syncState?.last_entries_sync_at && (
          <p className="mt-3 text-xs text-gray-500">
            上次条目同步：{syncState.last_entries_sync_at.slice(0, 16).replace("T", " ")}
          </p>
        )}
      </section>

      {/* 元数据同步 */}
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <Send size={18} className="text-sky-400" />
          元数据同步（封面/简介/metadata）
        </h2>
        <div className="flex flex-wrap gap-3 mb-4">
          <button
            onClick={() =>
              runAction("metadata-sync", "补齐一批", {
                maxItems: METADATA_BATCH,
                background: true,
              })
            }
            disabled={sectionBusy}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Send size={14} />
            补齐一批（{METADATA_BATCH} 部）
          </button>
          <button
            onClick={startMetadataBackfill}
            disabled={sectionBusy}
            className="px-4 py-2 bg-sky-700 hover:bg-sky-800 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Send size={14} />
            全量补齐元数据（后台完整跑）
          </button>
        </div>
        {syncLease && (
          <div className="space-y-2">
            <TaskProgressPanel
              message={syncProgress?.message || "正在补齐元数据（封面/简介）…"}
              done={syncProgress?.done}
              total={syncProgress?.total}
              startedAt={syncProgress ? syncLease.started_at : undefined}
            />
            <div className="flex items-center gap-3">
              <button
                onClick={cancelTask}
                className="px-3 py-1.5 bg-[#2a2a2a] hover:bg-red-900/40 hover:text-red-300 text-gray-400 border border-[#333] rounded-lg text-xs flex items-center gap-1.5 transition-colors"
              >
                <XCircleIcon size={12} />
                取消任务
              </button>
              <span className="text-xs text-gray-600">
                运行中→当前这部完成后停止；无响应（进度 5 分钟未更新）→ 直接清理残留状态
              </span>
            </div>
          </div>
        )}
        {(syncState?.last_metadata_sync_at || syncState?.last_metadata_sync_stats) && (
          <div className="mt-3 text-xs text-gray-500">
            {syncState?.last_metadata_sync_at && (
              <p>
                上次补齐：{syncState.last_metadata_sync_at.slice(0, 16).replace("T", " ")}
              </p>
            )}
            {syncState?.last_metadata_sync_stats && (
              <p className="mt-1 text-gray-600">
                {summarize("metadata-sync", syncState.last_metadata_sync_stats)}
              </p>
            )}
          </div>
        )}
      </section>

      {/* 台账 */}
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-lg">状态台账</h2>
          <button
            onClick={purgeLegacy}
            disabled={sectionBusy}
            className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 disabled:opacity-50 text-red-300 border border-red-600/40 rounded-lg text-xs flex items-center gap-1.5 transition-colors"
          >
            <Trash2 size={12} />
            清空短剧库（危险）
          </button>
        </div>
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
            {(
              [
                ["published", "已发布", "text-green-400"],
                ["offline", "已下线", "text-gray-500"],
              ] as const
            ).map(([key, label, color]) => (
              <div key={key} className="bg-black/30 border border-[#2a2a2a] rounded-lg p-3">
                <div className={`text-2xl font-bold ${color}`}>
                  {stats.by_status[key] ?? 0}
                </div>
                <div className="text-xs text-gray-500 mt-1">{label}</div>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {recent.map((drama) => (
            <div
              key={drama.id}
              className="flex items-center gap-3 bg-black/20 border border-[#2a2a2a] rounded-lg px-3 py-2 text-sm"
            >
              <span
                className={`shrink-0 w-16 text-xs font-medium ${
                  drama.status === "published" ? "text-green-400" : "text-gray-500"
                }`}
              >
                {drama.status === "published" ? "已发布" : "已下线"}
              </span>
              <span className="flex-1 min-w-0 text-gray-300 truncate">
                {drama.title}
                {drama.episode_count ? `（${drama.episode_count}集）` : ""}
              </span>
              <span className="shrink-0 text-[11px] text-gray-600">
                {drama.updated_at.slice(0, 10)}
              </span>
              <button
                onClick={() => deleteDrama(drama)}
                disabled={sectionBusy}
                title="删除本地记录"
                className="shrink-0 p-1 text-gray-600 hover:text-red-400 disabled:opacity-40 transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {recent.length === 0 && (
            <p className="text-sm text-gray-600">暂无数据，先跑一轮条目同步。</p>
          )}
        </div>
      </section>
    </div>
  );
}

function summarize(action: string, data: unknown): string {
  if (!data || typeof data !== "object") return "完成";
  const stats = data as Record<string, unknown>;
  if (action === "entries-sync") {
    return `拉取 ${stats.fetched ?? 0} 行、新建 ${stats.created ?? 0}、更新 ${
      stats.updated ?? 0
    }、合并 ${stats.collapsed ?? 0}、下线 ${stats.offline_marked ?? 0}${
      stats.skipped_no_share ? `、无链接跳过 ${stats.skipped_no_share}` : ""
    }`;
  }
  if (action === "metadata-sync") {
    return `补齐 ${stats.attempted ?? 0} 部：封面 ${stats.covers_mirrored ?? 0}、简介 ${
      stats.intros_set ?? 0
    }、metadata ${stats.metadata_set ?? 0}；已完整 ${stats.resolved ?? 0}、待重试 ${
      stats.still_missing ?? 0
    }、源缺失 ${stats.source_missing ?? 0}`;
  }
  if (action === "purge-legacy") {
    return `已删除 ${stats.deleted ?? 0} 条记录`;
  }
  return "完成";
}
