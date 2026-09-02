"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Clapperboard,
  KeyRound,
  RefreshCw,
  Tag,
  Tags,
  Send,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import type { ToastState, ConfirmState } from "@/components/admin/types";
import { TaskProgressPanel } from "@/components/admin/TaskProgressPanel";

/**
 * 短剧源管理 Tab
 *
 * 三块能力：
 *  1. 夸克凭证：粘贴 cookie → 服务端验证并 AES 加密落库（GET 回显掩码）
 *  2. 抓取：全量回填 / 增量跟更 / 标签回填（同步执行，返回统计）
 *  3. 转存：批量转存（串行防风控）与元数据补齐（同步小批 / 后台全量），
 *     查看状态台账与最近条目
 *
 * 任务执行期间：POST 挂起等待，前端每 3s 轮询 GET 读取 sync_state 的
 * 里的实时进度（running_scrape / running_transfer 双槽位，流水线写库
 * 上报），在对应分区显示进度条；curl 等外部触发的任务同样能看到。长任务（全量回填/整批转存）仍建议服务器挂任务执行。
 */

const PROGRESS_POLL_INTERVAL_MS = 3_000;

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
  last_article_watermark?: number;
  last_scrape_at?: string;
  last_scrape_mode?: string;
  last_scrape_stats?: Record<string, unknown>;
  last_backfill_resume_page?: number | null;
  last_transfer_at?: string;
  last_transfer_stats?: Record<string, unknown>;
  last_metadata_backfill_at?: string;
  last_metadata_backfill_stats?: Record<string, unknown>;
  running_scrape?: TaskLease | null;
  running_transfer?: TaskLease | null;
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
  transfer_error?: string;
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
        setCoverMirrorReady(!!syncPayload.data.cover_mirror_ready);
      }
    } catch (error) {
      console.warn("读取短剧源状态失败:", error);
    }
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  // 未过期的运行租约（本页触发的或 curl 等外部触发的任务都算）；
  // 抓取与转存租约独立，可同时各跑一个
  const scrapeLease =
    syncState?.running_scrape &&
    new Date(syncState.running_scrape.expires_at).getTime() > Date.now()
      ? syncState.running_scrape
      : null;
  const transferLease =
    syncState?.running_transfer &&
    new Date(syncState.running_transfer.expires_at).getTime() > Date.now()
      ? syncState.running_transfer
      : null;
  const isPolling =
    scrapeLease !== null ||
    transferLease !== null ||
    runningAction !== null ||
    pendingBackground !== null;

  // 任务执行期间轮询同步状态，驱动实时进度展示；节流由 loadState 内部兜底
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
    if (pendingBackground && (scrapeLease !== null || transferLease !== null)) {
      setPendingBackground(null);
    }
  }, [pendingBackground, scrapeLease, transferLease]);

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
    try {      const response = await fetch("/api/admin/short-dramas", {
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

  /** 取消运行中/残留的任务：活任务优雅停（当前条目完成后），死任务清残留 */
  const cancelTask = async (target: "transfer" | "scrape") => {
    try {
      const response = await fetch("/api/admin/short-dramas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "task-cancel", target }),
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

  /** 全量回填：数小时长任务，后台启动 + 确认弹窗说明耗时 */
  const startFullBackfill = () => {
    onShowConfirm({
      title: "启动全量回填？",
      message:
        "全量约 7 万条 / 2323 个列表页，预计连续运行数小时，将在后台执行（可关闭页面，服务器继续抓）。已入库的条目自动跳过、不重复抓取；中断后重新点击会从上次断点页自动续跑。抓取完可在「待转存数据」里批量转存。",
      confirmText: "启动全量回填",
      onConfirm: async () => {
        await runAction("scrape-backfill", "全量回填", { background: true });
      },
    });
  };

  /** 全量补齐元数据：后台一次跑完整个补齐队列 + 确认弹窗说明耗时与终结标记 */
  const startMetadataBackfill = () => {
    onShowConfirm({
      title: "启动全量补齐元数据？",
      message:
        "将对所有「转存完成但缺封面/简介/metadata」的条目重新列目录补齐（每部约 10-30 秒，队列可能上百部，将在后台执行，可关闭页面）。发布日期新的先补，补完即出现在首页前列。源站分享夹里本来就没有的部件会记为「源缺失」，之后不再重复尝试。",
      confirmText: "启动全量补齐",
      onConfirm: async () => {
        await runAction("metadata-backfill", "全量补齐元数据", { background: true });
      },
    });
  };

  // 进度按任务归属分区展示：抓取区只显示 scrape 租约，转存区只显示
  // transfer 租约（两者可同屏各自显示进度条）
  const scrapeProgress = scrapeLease?.progress ?? null;
  const transferProgress = transferLease?.progress ?? null;
  const pendingTransfer =
    pendingBackground !== null &&
    (pendingBackground.action === "transfer" ||
      pendingBackground.action === "metadata-backfill");
  const pendingScrape =
    pendingBackground !== null && pendingBackground.action === "scrape-backfill";
  const scrapeSectionBusy =
    runningAction === "scrape-incremental" ||
    runningAction === "scrape-backfill" ||
    runningAction === "tag-sync" ||
    runningAction === "tag-group-sync" ||
    scrapeLease !== null ||
    pendingScrape;
  const transferSectionBusy =
    runningAction === "transfer" ||
    runningAction === "metadata-backfill" ||
    transferLease !== null ||
    pendingTransfer;
  const defaultScrapeMessage =
    runningAction === "tag-sync" ? "正在逐标签搜索回填…" : "正在抓取源站…";
  const defaultTransferMessage =
    runningAction === "metadata-backfill" || pendingBackground?.action === "metadata-backfill"
      ? "正在补齐元数据（封面/简介）…"
      : "正在转存到自己夸克网盘…";

  return (
    <div className="space-y-8">
      {/* 凭证 */}
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <KeyRound size={18} className="text-orange-400" />
          夸克网盘凭证
        </h2>
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
            尚未配置凭证：请在浏览器登录 pan.quark.cn 后，从 DevTools → Network 任意请求的 Request Headers 复制完整 cookie 粘贴到下方（需含 __pus/__kps/__puus 等登录态字段）
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

      {/* 抓取 */}
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <Clapperboard size={18} className="text-red-500" />
          短剧抓取（duanjugou.top）
        </h2>
        <div className="flex flex-wrap gap-3 mb-4">
          <button
            onClick={() => runAction("scrape-incremental", "增量抓取", {})}
            disabled={scrapeSectionBusy}
            className="px-4 py-2 bg-[#2a2a2a] hover:bg-[#333] disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <RefreshCw size={14} className={runningAction === "scrape-incremental" ? "animate-spin" : ""} />
            增量跟更
          </button>
          <button
            onClick={() => runAction("scrape-backfill", "回填一批", { maxDetails: 500 })}
            disabled={scrapeSectionBusy}
            className="px-4 py-2 bg-[#2a2a2a] hover:bg-[#333] disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <RefreshCw size={14} className={runningAction === "scrape-backfill" ? "animate-spin" : ""} />
            回填一批（500 条详情）
          </button>
          <button
            onClick={startFullBackfill}
            disabled={scrapeSectionBusy}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Clapperboard size={14} />
            全量回填（后台完整跑）
          </button>
          <button
            onClick={() => runAction("tag-sync", "标签回填", {})}
            disabled={scrapeSectionBusy}
            className="px-4 py-2 bg-[#2a2a2a] hover:bg-[#333] disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Tag size={14} />
            标签回填
          </button>
          <button
            onClick={() => runAction("tag-group-sync", "标签分组刷新", {})}
            disabled={scrapeSectionBusy}
            className="px-4 py-2 bg-[#2a2a2a] hover:bg-[#333] disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Tags size={14} />
            刷新标签分组
          </button>
        </div>
        {scrapeSectionBusy && (
          <div className="space-y-2">
            <TaskProgressPanel
              message={scrapeProgress?.message || defaultScrapeMessage}
              done={scrapeProgress?.done}
              total={scrapeProgress?.total}
              startedAt={scrapeProgress ? scrapeLease?.started_at : undefined}
            />
            <div className="flex items-center gap-3">
              <button
                onClick={() => cancelTask("scrape")}
                className="px-3 py-1.5 bg-[#2a2a2a] hover:bg-red-900/40 hover:text-red-300 text-gray-400 border border-[#333] rounded-lg text-xs flex items-center gap-1.5 transition-colors"
              >
                <XCircle size={12} />
                取消任务
              </button>
            </div>
          </div>
        )}
        <p className="text-xs text-gray-600">
          「全量回填」后台完整抓取约 7 万条 / 2323 个列表页（数小时），可关闭页面，进度实时展示；
          「回填一批」同步跑 500 条详情，适合小步补抓。「刷新标签分组」同步源站标签归类供前台标签云分组展示；
          「标签回填」逐标签搜索把标签写到对应短剧。抓取按源站文章 ID 幂等入库，重复执行不会产生重复数据；
          也可用 curl 挂 crontab：
          <code className="ml-1 px-1.5 py-0.5 bg-black/40 rounded text-[11px] text-gray-400">
            curl -X POST -b admin_session=… -H &apos;Content-Type: application/json&apos; -d &apos;{"{"}&quot;action&quot;:&quot;scrape-backfill&quot;,&quot;background&quot;:true{"}"}&apos; /api/admin/short-dramas
          </code>
        </p>
        {syncState?.last_scrape_at && (
          <p className="mt-3 text-xs text-gray-500">
            上次抓取：{syncState.last_scrape_mode || "-"} @{" "}
            {syncState.last_scrape_at.slice(0, 16).replace("T", " ")} · 水位文章 ID：{" "}
            {syncState.last_article_watermark ?? "-"}
            {syncState.last_backfill_resume_page
              ? ` · 回填断点：第 ${syncState.last_backfill_resume_page} 页（点「全量回填」自动续跑）`
              : ""}
          </p>
        )}
      </section>

      {/* 转存 */}
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <Send size={18} className="text-sky-400" />
          批量转存到自己夸克网盘
        </h2>
        {!coverMirrorReady && (
          <p className="mb-3 text-xs text-yellow-400/90 flex items-center gap-2">
            <AlertTriangle size={13} />
            R2 封面镜像未配置（CLOUDFLARE_R2_* 环境变量缺失）：转存仍可用，但封面/简介不会关联
          </p>
        )}
        <div className="flex flex-wrap gap-3 mb-4">
          <button
            onClick={() => runAction("transfer", "转存一批", { maxItems: 10 })}
            disabled={transferSectionBusy}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Send size={14} />
            转存 10 部
          </button>
          <button
            onClick={() => runAction("metadata-backfill", "补齐一批", { maxItems: 20 })}
            disabled={transferSectionBusy}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Send size={14} />
            补齐一批（20 部）
          </button>
          <button
            onClick={startMetadataBackfill}
            disabled={transferSectionBusy}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Send size={14} />
            全量补齐元数据（后台完整跑）
          </button>
        </div>
        {transferSectionBusy && (
          <div className="space-y-2">
            <TaskProgressPanel
              message={transferProgress?.message || defaultTransferMessage}
              done={transferProgress?.done}
              total={transferProgress?.total}
              startedAt={transferProgress ? transferLease?.started_at : undefined}
            />
            <div className="flex items-center gap-3">
              <button
                onClick={() => cancelTask("transfer")}
                className="px-3 py-1.5 bg-[#2a2a2a] hover:bg-red-900/40 hover:text-red-300 text-gray-400 border border-[#333] rounded-lg text-xs flex items-center gap-1.5 transition-colors"
              >
                <XCircle size={12} />
                取消任务
              </button>
              <span className="text-xs text-gray-600">
                运行中→当前这部完成后停止；无响应（进度 5 分钟未更新）→ 直接清理残留状态
              </span>
            </div>
          </div>
        )}
        {syncState?.last_transfer_at && (
          <p className="text-xs text-gray-500">
            上次转存：{syncState.last_transfer_at.slice(0, 16).replace("T", " ")}
            {syncState?.last_metadata_backfill_at && (
              <> · 上次补齐：{syncState.last_metadata_backfill_at.slice(0, 16).replace("T", " ")}</>
            )}
          </p>
        )}
        {syncState?.last_metadata_backfill_stats && (
          <p className="mt-1 text-xs text-gray-600">
            {summarize("metadata-backfill", syncState.last_metadata_backfill_stats)}
          </p>
        )}
      </section>

      {/* 台账 */}
      <section className="bg-[#181818] border border-[#333] rounded-xl p-6">
        <h2 className="text-white font-bold text-lg mb-4">状态台账</h2>
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
            {(
              [
                ["discovered", "待转存", "text-gray-300"],
                ["transferring", "转存中", "text-yellow-300"],
                ["done", "已完成", "text-green-400"],
                ["failed", "失败", "text-red-400"],
                ["invalid", "无效", "text-gray-500"],
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
                  drama.status === "done"
                    ? "text-green-400"
                    : drama.status === "failed"
                      ? "text-red-400"
                      : drama.status === "transferring"
                        ? "text-yellow-300"
                        : "text-gray-500"
                }`}
              >
                {drama.status}
              </span>
              <span className="flex-1 min-w-0 text-gray-300 truncate">
                {drama.title}
                {drama.episode_count ? `（${drama.episode_count}集）` : ""}
              </span>
              {drama.transfer_error && (
                <span className="shrink-0 max-w-[40%] text-xs text-red-400/80 truncate" title={drama.transfer_error}>
                  {drama.transfer_error}
                </span>
              )}
            </div>
          ))}
          {recent.length === 0 && (
            <p className="text-sm text-gray-600">暂无数据，先跑一轮抓取。</p>
          )}
        </div>
      </section>
    </div>
  );
}

function summarize(action: string, data: unknown): string {
  if (!data || typeof data !== "object") return "完成";
  const stats = data as Record<string, unknown>;
  if (action === "transfer") {
    return `成功 ${stats.succeeded ?? 0}、失败 ${stats.failed ?? 0}、封面 ${stats.covers_mirrored ?? 0}`;
  }
  if (action === "metadata-backfill") {
    return `补齐 ${stats.attempted ?? 0} 部：封面 ${stats.covers_mirrored ?? 0}、简介 ${stats.intros_set ?? 0}、metadata ${stats.metadata_set ?? 0}；已完整 ${stats.resolved ?? 0}、待重试 ${stats.still_missing ?? 0}、源缺失 ${stats.source_missing ?? 0}`;
  }
  if (action === "tag-sync") {
    return `标签 ${stats.tags_processed ?? 0}/${stats.tags_total ?? 0}、命中 ${stats.dramas_tagged ?? 0}`;
  }
  if (action === "tag-group-sync") {
    return `分组 ${stats.categories ?? 0}、标签 ${stats.tags_total ?? 0}（${stats.source ?? "-"}）`;
  }
  return `新建 ${stats.items_created ?? 0}、更新 ${stats.items_updated ?? 0}、详情 ${stats.details_fetched ?? 0}`;
}
