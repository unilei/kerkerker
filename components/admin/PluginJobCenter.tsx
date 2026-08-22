"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  XCircle,
} from "lucide-react";
import type { ConfirmState, ToastState } from "./types";

type JobStatus =
  | "queued"
  | "running"
  | "retry_waiting"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

interface JobProgress {
  total: number;
  processed: number;
  created: number;
  failed: number;
  skipped: number;
}

interface JobError {
  code?: string;
  message: string;
  retryable?: boolean;
}

interface Job {
  run_id: string;
  job_id: string;
  control_mode: "host" | "external-report";
  host_claimable?: boolean;
  plugin_id: string;
  plugin_version: string;
  profile_id: string;
  profile: string;
  config_version: string;
  status: JobStatus;
  attempt: number;
  retry_policy: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  next_retry_at?: string;
  lease?: { owner: string; fence: number; heartbeat_at: string; expires_at: string };
  heartbeat_at?: string;
  cancel_requested: boolean;
  progress: JobProgress;
  error?: JobError;
  revision: number;
  timeline_pending: boolean;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
}

interface JobEvent {
  event_id: string;
  run_id: string;
  sequence: number;
  kind: "started" | "progress" | "finished";
  occurred_at: string;
  received_at: string;
  status: string;
  progress: JobProgress;
  error?: { code?: string; message: string };
}

interface Props {
  onShowToast: (toast: ToastState) => void;
  onShowConfirm: (confirm: ConfirmState) => void;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "排队中",
  running: "运行中",
  retry_waiting: "等待重试",
  succeeded: "成功",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_CLASSES: Record<JobStatus, string> = {
  queued: "text-amber-300",
  running: "text-sky-300",
  retry_waiting: "text-amber-300",
  succeeded: "text-emerald-300",
  partial: "text-amber-300",
  failed: "text-red-300",
  cancelled: "text-gray-400",
};

const ACTIVE_STATUSES = new Set<JobStatus>(["queued", "running", "retry_waiting"]);

function formatTime(value?: string): string {
  if (!value) return "-";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value.slice(0, 19).replace("T", " ");
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function progressPercent(job: Job): number {
  if (job.progress.total <= 0) return 0;
  return Math.min(100, Math.round((job.progress.processed / job.progress.total) * 100));
}

function statusIcon(status: JobStatus) {
  if (status === "succeeded") return CheckCircle2;
  if (status === "failed" || status === "partial") return CircleAlert;
  if (status === "cancelled") return XCircle;
  if (status === "running") return Activity;
  return Clock3;
}

function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  return fallback;
}

export function PluginJobCenter({ onShowToast, onShowConfirm }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | JobStatus>("all");
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.run_id === selectedRunId) || jobs[0] || null,
    [jobs, selectedRunId]
  );

  const loadJobs = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50" });
    if (statusFilter !== "all") params.set("status", statusFilter);
    const response = await fetch(`/api/plugins/jobs?${params.toString()}`, { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code !== 200) {
      throw new Error(extractMessage(body, "读取插件任务失败"));
    }
    const nextJobs = (body.data?.jobs || []) as Job[];
    setJobs(nextJobs);
    setSelectedRunId((current) =>
      current && nextJobs.some((job) => job.run_id === current) ? current : nextJobs[0]?.run_id || null
    );
    setError(null);
  }, [statusFilter]);

  const loadEvents = useCallback(async (runId: string) => {
    setEventsLoading(true);
    try {
      const response = await fetch(
        `/api/plugins/jobs/events?run_id=${encodeURIComponent(runId)}&limit=100`,
        { cache: "no-store" }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.code !== 200) {
        throw new Error(extractMessage(body, "读取任务日志失败"));
      }
      setEvents((body.data?.events || []) as JobEvent[]);
    } catch (loadError) {
      setEvents([]);
      onShowToast({
        message: loadError instanceof Error ? loadError.message : "读取任务日志失败",
        type: "error",
      });
    } finally {
      setEventsLoading(false);
    }
  }, [onShowToast]);

  useEffect(() => {
    setLoading(true);
    loadJobs().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "读取插件任务失败");
    }).finally(() => setLoading(false));
  }, [loadJobs]);

  useEffect(() => {
    if (!selectedRunId) {
      setEvents([]);
      return;
    }
    void loadEvents(selectedRunId);
  }, [loadEvents, selectedRunId]);

  useEffect(() => {
    if (!jobs.some((job) => ACTIVE_STATUSES.has(job.status))) return;
    const timer = window.setInterval(() => {
      void loadJobs();
      if (selectedJob) void loadEvents(selectedJob.run_id);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [jobs, loadEvents, loadJobs, selectedJob]);

  const runAction = async (job: Job, action: "cancel" | "retry") => {
    setBusyRunId(job.run_id);
    try {
      const response = await fetch(`/api/plugins/jobs/${encodeURIComponent(job.run_id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          reason: action === "cancel" ? "管理员在任务中心请求取消" : "管理员在任务中心请求重试",
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.code !== 200) {
        throw new Error(extractMessage(body, "任务操作失败"));
      }
      onShowToast({
        message: action === "cancel" ? "取消请求已提交" : "重试请求已提交",
        type: "success",
      });
      await loadJobs();
      await loadEvents(job.run_id);
    } catch (actionError) {
      onShowToast({
        message: actionError instanceof Error ? actionError.message : "任务操作失败",
        type: "error",
      });
    } finally {
      setBusyRunId(null);
    }
  };

  const requestCancel = (job: Job) => {
    onShowConfirm({
      title: "取消插件任务",
      message: `确定取消任务「${job.job_id}」吗？运行中的 worker 会在下一次心跳或副作用边界停止。`,
      danger: true,
      onConfirm: () => runAction(job, "cancel"),
    });
  };

  const counts = useMemo(() => {
    return jobs.reduce<Record<string, number>>((result, job) => {
      result[job.status] = (result[job.status] || 0) + 1;
      return result;
    }, {});
  }, [jobs]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#333] pb-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-medium text-white">
            <Activity size={19} className="text-[#E50914]" />
            插件任务中心
          </h2>
          <p className="mt-1 text-xs text-gray-500">查看宿主任务和外部刷新器上报的进度、事件与生命周期状态。</p>
        </div>
        <button
          type="button"
          onClick={() => void loadJobs()}
          className="inline-flex h-9 items-center gap-1.5 rounded border border-[#444] bg-[#252525] px-3 text-xs text-gray-200 hover:bg-[#303030]"
          title="刷新任务"
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-400">
        <span>共 {jobs.length} 条</span>
        <span className="text-sky-300">运行中 {counts.running || 0}</span>
        <span className="text-amber-300">待处理 {(counts.queued || 0) + (counts.retry_waiting || 0)}</span>
        <span className="text-red-300">失败 {counts.failed || 0}</span>
        <label className="ml-auto flex items-center gap-2">
          <span>状态</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "all" | JobStatus)}
            className="h-8 rounded border border-[#444] bg-[#252525] px-2 text-xs text-white focus:outline-none focus:border-[#E50914]"
          >
            <option value="all">全部</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 border border-red-900/60 bg-red-950/20 px-4 py-3 text-sm text-red-200">
          <span>{error}</span>
          <button type="button" onClick={() => void loadJobs()} className="text-xs underline underline-offset-2">重试</button>
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" />正在读取任务…</div>
      ) : jobs.length === 0 ? (
        <div className="border border-dashed border-[#444] px-4 py-10 text-center text-sm text-gray-500">暂无符合条件的插件任务</div>
      ) : (
        <div className="overflow-x-auto border border-[#333] bg-[#181818]">
          <table className="min-w-[860px] w-full border-collapse text-left text-xs">
            <thead className="border-b border-[#333] bg-[#202020] text-gray-500">
              <tr>
                <th className="px-3 py-2.5 font-normal">任务</th>
                <th className="px-3 py-2.5 font-normal">来源 / 画像</th>
                <th className="px-3 py-2.5 font-normal">状态</th>
                <th className="px-3 py-2.5 font-normal">进度</th>
                <th className="px-3 py-2.5 font-normal">更新时间</th>
                <th className="px-3 py-2.5 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const Icon = statusIcon(job.status);
                const selected = selectedJob?.run_id === job.run_id;
                const canCancel = ACTIVE_STATUSES.has(job.status) && job.control_mode === "host" && job.host_claimable !== false;
                const canRetry = (job.status === "failed" || job.status === "partial") && job.control_mode === "host" && job.host_claimable !== false && !job.cancel_requested;
                return (
                  <tr
                    key={job.run_id}
                    onClick={() => setSelectedRunId(job.run_id)}
                    className={`cursor-pointer border-b border-[#2b2b2b] transition-colors ${selected ? "bg-[#292020]" : "hover:bg-[#222]"}`}
                  >
                    <td className="max-w-[270px] px-3 py-3 align-top">
                      <p className="truncate font-medium text-white" title={job.job_id}>{job.job_id}</p>
                      <p className="mt-1 truncate font-mono text-[10px] text-gray-600" title={job.run_id}>{job.run_id}</p>
                    </td>
                    <td className="px-3 py-3 align-top text-gray-400">
                      <p className="truncate" title={job.plugin_id}>{job.plugin_id}</p>
                      <p className="mt-1 text-[10px] text-gray-600">{job.profile_id} · v{job.plugin_version}</p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className={`inline-flex items-center gap-1 ${STATUS_CLASSES[job.status]}`}>
                        <Icon size={14} />{STATUS_LABELS[job.status]}
                      </span>
                      {job.cancel_requested && <span className="mt-1 block text-[10px] text-amber-300">已请求取消</span>}
                    </td>
                    <td className="w-[190px] px-3 py-3 align-top">
                      <div className="flex items-center justify-between text-[10px] text-gray-500">
                        <span>{job.progress.processed}/{job.progress.total || 0}</span>
                        <span>{progressPercent(job)}%</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden bg-[#333]">
                        <div className="h-full bg-[#E50914] transition-[width]" style={{ width: `${progressPercent(job)}%` }} />
                      </div>
                      <p className="mt-1 text-[10px] text-gray-600">失败 {job.progress.failed} · 跳过 {job.progress.skipped}</p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 align-top text-gray-500">{formatTime(job.updated_at)}</td>
                    <td className="whitespace-nowrap px-3 py-3 align-top text-right">
                      <div className="flex justify-end gap-1.5">
                        {canCancel && (
                          <button type="button" onClick={(event) => { event.stopPropagation(); requestCancel(job); }} disabled={busyRunId === job.run_id} className="inline-flex h-7 items-center gap-1 rounded border border-red-900/70 px-2 text-[11px] text-red-200 hover:bg-red-950/40 disabled:opacity-50" title="取消任务">
                            {busyRunId === job.run_id ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
                            取消
                          </button>
                        )}
                        {canRetry && (
                          <button type="button" onClick={(event) => { event.stopPropagation(); void runAction(job, "retry"); }} disabled={busyRunId === job.run_id} className="inline-flex h-7 items-center gap-1 rounded border border-[#555] px-2 text-[11px] text-gray-200 hover:bg-[#333] disabled:opacity-50" title="重试任务">
                            {busyRunId === job.run_id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                            重试
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedJob && (
        <div className="grid gap-4 border-t border-[#333] pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-white">任务详情</h3>
              <span className="font-mono text-[10px] text-gray-600">rev {selectedJob.revision}</span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <dt className="text-gray-600">控制模式</dt><dd className="text-gray-300">{selectedJob.control_mode === "host" ? "宿主执行" : "外部上报"}</dd>
              <dt className="text-gray-600">尝试次数</dt><dd className="text-gray-300">{selectedJob.attempt} / {selectedJob.retry_policy.maxAttempts}</dd>
              <dt className="text-gray-600">创建时间</dt><dd className="text-gray-300">{formatTime(selectedJob.created_at)}</dd>
              <dt className="text-gray-600">开始 / 结束</dt><dd className="text-gray-300">{formatTime(selectedJob.started_at)} / {formatTime(selectedJob.finished_at)}</dd>
              {selectedJob.lease && <><dt className="text-gray-600">租约</dt><dd className="text-gray-300">{selectedJob.lease.owner} · fence {selectedJob.lease.fence} · 到期 {formatTime(selectedJob.lease.expires_at)}</dd></>}
              {selectedJob.error && <><dt className="text-gray-600">错误</dt><dd className="break-words text-red-200">{selectedJob.error.message}</dd></>}
            </dl>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-white">事件日志</h3>
              {eventsLoading && <Loader2 size={14} className="animate-spin text-gray-500" />}
            </div>
            {events.length === 0 ? (
              <p className="border border-dashed border-[#444] px-3 py-5 text-xs text-gray-600">暂无事件，或事件仍在写入。</p>
            ) : (
              <ol className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {events.slice().reverse().map((event) => (
                  <li key={event.event_id} className="border-l border-[#444] pl-3 text-xs">
                    <div className="flex items-center justify-between gap-2 text-gray-500">
                      <span>#{event.sequence} · {event.kind}</span><time>{formatTime(event.occurred_at)}</time>
                    </div>
                    <p className="mt-1 text-gray-300">{event.status} · {event.progress.processed}/{event.progress.total}</p>
                    {event.error && <p className="mt-1 break-words text-red-200">{event.error.message}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
