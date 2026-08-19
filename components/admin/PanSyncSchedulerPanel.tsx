"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Square,
  TriangleAlert,
} from "lucide-react";
import type { ToastState } from "./types";

type Task = "catalog" | "incremental";
type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

interface Schedule {
  task: Task;
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: string;
  batch_limit: number;
  max_batches: number;
  next_run_at?: string;
}

interface Run {
  run_id: string;
  task: Task;
  trigger: "scheduled" | "manual";
  status: RunStatus;
  batch_limit: number;
  max_batches: number;
  discovered: number;
  queued: number;
  processed: number;
  synced: number;
  empty: number;
  failed: number;
  imported: number;
  refreshed: number;
  disabled: number;
  remaining: number;
  progress_total: number;
  completed_batches: number;
  current_douban_id?: string;
  current_title?: string;
  last_error?: string;
  cancel_requested: boolean;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

interface EventItem {
  seq: number;
  level: "info" | "warning" | "error";
  message: string;
  data?: Record<string, unknown>;
  created_at: string;
}

interface Dashboard {
  schedules: Schedule[];
  runs: Run[];
  active_run: Run | null;
  events: EventItem[];
}

interface Props {
  onShowToast: (toast: ToastState) => void;
}

const TASK_LABELS: Record<Task, string> = {
  catalog: "影片目录同步",
  incremental: "kkpans 增量同步",
};

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已停止",
};

const STATUS_CLASSES: Record<RunStatus, string> = {
  queued: "text-amber-300",
  running: "text-blue-300",
  succeeded: "text-green-300",
  partial: "text-amber-300",
  failed: "text-red-300",
  cancelled: "text-gray-400",
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatTime(value?: string, timezone = "Asia/Shanghai") {
  if (!value) return "从未";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value.slice(0, 16).replace("T", " ");
  }
}

function formatRunTime(value?: string) {
  if (!value) return "等待启动";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value.slice(0, 19).replace("T", " ");
  }
}

function percent(run: Run | null) {
  if (!run || run.progress_total <= 0) return 0;
  return Math.min(100, Math.round((run.processed / run.progress_total) * 100));
}

function isActive(run?: Run | null) {
  return run?.status === "queued" || run?.status === "running";
}

export function PanSyncSchedulerPanel({ onShowToast }: Props) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyTask, setBusyTask] = useState<Task | "cancel" | null>(null);

  const load = useCallback(async (runId?: string | null) => {
    const params = new URLSearchParams({ limit: "30" });
    if (runId) params.set("run_id", runId);
    const response = await fetch(`/api/pan-resources/scheduler?${params}`, {
      cache: "no-store",
    });
    const result = await response.json();
    if (result.code !== 200) throw new Error(result.message || "读取调度状态失败");
    const next = result.data as Dashboard;
    setDashboard(next);
    if (!runId && !selectedRunId && next.active_run) setSelectedRunId(next.active_run.run_id);
    setLoading(false);
  }, [selectedRunId]);

  useEffect(() => {
    load().catch((error) => {
      setLoading(false);
      onShowToast({ message: error instanceof Error ? error.message : "读取调度状态失败", type: "error" });
    });
  }, [load, onShowToast]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      load(selectedRunId).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load, selectedRunId]);

  const selectedRun = useMemo(() => {
    if (!dashboard) return null;
    return (selectedRunId
      ? dashboard.runs.find((run) => run.run_id === selectedRunId) ||
        (dashboard.active_run?.run_id === selectedRunId ? dashboard.active_run : null)
      : null) || dashboard.active_run;
  }, [dashboard, selectedRunId]);

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/pan-resources/scheduler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (result.code !== 200) throw new Error(result.message || "调度操作失败");
    return result.data as { schedule?: Schedule; run?: Run };
  };

  const saveSchedule = async (schedule: Schedule, enabled?: boolean) => {
    setBusyTask(schedule.task);
    try {
      await post({
        action: "configure",
        task: schedule.task,
        enabled: enabled ?? schedule.enabled,
        time: `${pad(schedule.hour)}:${pad(schedule.minute)}`,
        timezone: schedule.timezone,
        batch_limit: schedule.batch_limit,
        max_batches: schedule.max_batches,
      });
      await load(selectedRunId);
      onShowToast({ message: `${TASK_LABELS[schedule.task]}配置已保存`, type: "success" });
    } catch (error) {
      onShowToast({ message: error instanceof Error ? error.message : "保存调度配置失败", type: "error" });
    } finally {
      setBusyTask(null);
    }
  };

  const runNow = async (task: Task) => {
    setBusyTask(task);
    try {
      const result = await post({ action: "run_now", task });
      if (result.run) setSelectedRunId(result.run.run_id);
      await load(result.run?.run_id);
      onShowToast({ message: `${TASK_LABELS[task]}已加入运行队列`, type: "success" });
    } catch (error) {
      onShowToast({ message: error instanceof Error ? error.message : "启动同步失败", type: "error" });
    } finally {
      setBusyTask(null);
    }
  };

  const cancel = async () => {
    if (!selectedRun || !isActive(selectedRun)) return;
    setBusyTask("cancel");
    try {
      await post({ action: "cancel", run_id: selectedRun.run_id });
      await load(selectedRun.run_id);
      onShowToast({ message: "已请求停止，当前影片完成后退出", type: "info" });
    } catch (error) {
      onShowToast({ message: error instanceof Error ? error.message : "停止任务失败", type: "error" });
    } finally {
      setBusyTask(null);
    }
  };

  if (loading && !dashboard) {
    return (
      <section className="bg-[#181818] border border-[#333] rounded-lg p-6">
        <div className="flex items-center gap-2 text-gray-400 text-sm"><Loader2 size={16} className="animate-spin" />正在加载后台调度器…</div>
      </section>
    );
  }

  return (
    <section className="bg-[#181818] border border-[#333] rounded-lg p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h3 className="text-white font-medium flex items-center gap-2"><Clock3 size={18} className="text-[#E50914]" />后台自动同步</h3>
          <p className="text-xs text-gray-500 mt-1">应用内部轮询执行，不依赖服务器 cron；配置、进度和日志保存在 MongoDB。</p>
        </div>
        <button onClick={() => load(selectedRunId).catch(() => undefined)} className="p-2 bg-[#333] hover:bg-[#444] text-gray-300 rounded" title="刷新调度状态"><RefreshCw size={15} /></button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2 mb-5">
        {(dashboard?.schedules || []).map((schedule) => (
          <div key={schedule.task} className="border border-[#333] bg-[#202020] rounded p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <p className="text-sm text-white">{TASK_LABELS[schedule.task]}</p>
                <p className="text-[11px] text-gray-500 mt-1">下次执行：{schedule.enabled ? formatTime(schedule.next_run_at, schedule.timezone) : "已关闭"}</p>
              </div>
              <button
                type="button"
                onClick={() => saveSchedule(schedule, !schedule.enabled)}
                disabled={busyTask !== null}
                className={`relative w-10 h-5 rounded-full transition-colors ${schedule.enabled ? "bg-[#E50914]" : "bg-[#444]"}`}
                title={schedule.enabled ? "关闭自动同步" : "开启自动同步"}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${schedule.enabled ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
              <label className="text-[11px] text-gray-500">执行时间
                <input
                  type="time"
                  value={`${pad(schedule.hour)}:${pad(schedule.minute)}`}
                  onChange={(event) => setDashboard((current) => current ? { ...current, schedules: current.schedules.map((item) => item.task === schedule.task ? { ...item, hour: Number(event.target.value.slice(0, 2)), minute: Number(event.target.value.slice(3, 5)) } : item) } : current)}
                  className="mt-1 w-full bg-[#303030] border border-[#444] rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-[#E50914]"
                />
              </label>
              <label className="text-[11px] text-gray-500">每批影片
                <input
                  type="number"
                  min={1}
                  max={schedule.task === "catalog" ? 20 : 500}
                  value={schedule.batch_limit}
                  onChange={(event) => setDashboard((current) => current ? { ...current, schedules: current.schedules.map((item) => item.task === schedule.task ? { ...item, batch_limit: Number(event.target.value) } : item) } : current)}
                  className="mt-1 w-full bg-[#303030] border border-[#444] rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-[#E50914]"
                />
              </label>
              <label className="text-[11px] text-gray-500">最多批次
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={schedule.max_batches}
                  disabled={schedule.task === "incremental"}
                  onChange={(event) => setDashboard((current) => current ? { ...current, schedules: current.schedules.map((item) => item.task === schedule.task ? { ...item, max_batches: Number(event.target.value) } : item) } : current)}
                  className="mt-1 w-full bg-[#303030] border border-[#444] rounded px-2 py-1.5 text-xs text-white disabled:opacity-50 focus:outline-none focus:border-[#E50914]"
                />
                {schedule.task === "incremental" && <span className="block mt-1 text-[10px] text-gray-600">固定为 1 批</span>}
              </label>
              <button onClick={() => saveSchedule(schedule)} disabled={busyTask !== null} className="h-[30px] bg-[#333] hover:bg-[#444] disabled:opacity-50 text-white text-xs rounded flex items-center justify-center gap-1.5" title="保存配置">
                {busyTask === schedule.task ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}保存
              </button>
            </div>
            <button onClick={() => runNow(schedule.task)} disabled={busyTask !== null || Boolean(dashboard?.active_run && isActive(dashboard.active_run))} className="mt-3 w-full py-1.5 bg-[#E50914] hover:bg-[#f6121d] disabled:opacity-50 text-white text-xs rounded flex items-center justify-center gap-1.5">
              <Play size={13} />立即运行
            </button>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="border border-[#333] rounded p-4 bg-[#202020] min-w-0">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2"><Activity size={16} className="text-blue-300" /><span className="text-sm text-white">运行进度</span></div>
            {selectedRun && isActive(selectedRun) && <button onClick={cancel} disabled={busyTask === "cancel"} className="px-2 py-1 text-xs text-red-300 hover:text-red-200 border border-red-900/60 rounded flex items-center gap-1">{busyTask === "cancel" ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}停止</button>}
          </div>
          {selectedRun ? (
            <>
              <div className="flex items-center justify-between text-xs mb-2"><span className={STATUS_CLASSES[selectedRun.status]}>{STATUS_LABELS[selectedRun.status]} · {TASK_LABELS[selectedRun.task]}</span><span className="text-gray-500">{percent(selectedRun)}%</span></div>
              <div className="h-2 bg-[#333] rounded overflow-hidden"><div className={`h-full ${selectedRun.status === "failed" ? "bg-red-500" : "bg-[#E50914]"} transition-all`} style={{ width: `${percent(selectedRun)}%` }} /></div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-xs">
                <span className="text-gray-500">处理 <b className="text-white">{selectedRun.processed}</b></span>
                <span className="text-gray-500">新增 <b className="text-green-300">{selectedRun.imported}</b></span>
                <span className="text-gray-500">失败 <b className="text-red-300">{selectedRun.failed}</b></span>
                <span className="text-gray-500">剩余 <b className="text-white">{selectedRun.remaining}</b></span>
              </div>
              {selectedRun.current_title && <p className="mt-3 text-xs text-blue-200 truncate">当前：{selectedRun.current_title}（{selectedRun.current_douban_id}）</p>}
              {selectedRun.last_error && <p className="mt-2 text-xs text-red-300 break-words">{selectedRun.last_error}</p>}
              <p className="mt-3 text-[11px] text-gray-600">开始：{formatRunTime(selectedRun.started_at)} · 更新：{formatRunTime(selectedRun.updated_at)}</p>
            </>
          ) : <p className="text-sm text-gray-600 py-8 text-center">还没有运行记录</p>}
        </div>

        <div className="border border-[#333] rounded p-4 bg-[#202020] min-w-0">
          <div className="flex items-center gap-2 mb-3"><CheckCircle2 size={16} className="text-green-300" /><span className="text-sm text-white">最近运行</span></div>
          <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {(dashboard?.runs || []).map((run) => (
              <button key={run.run_id} onClick={() => { setSelectedRunId(run.run_id); load(run.run_id).catch(() => undefined); }} className={`w-full text-left px-2.5 py-2 rounded border ${selectedRun?.run_id === run.run_id ? "border-[#E50914] bg-[#2a1718]" : "border-[#333] hover:border-[#555]"}`}>
                <div className="flex items-center justify-between gap-2 text-xs"><span className="text-white truncate">{TASK_LABELS[run.task]}</span><span className={STATUS_CLASSES[run.status]}>{STATUS_LABELS[run.status]}</span></div>
                <div className="flex items-center justify-between gap-2 text-[11px] text-gray-600 mt-1"><span>{formatRunTime(run.created_at)} · {run.trigger === "scheduled" ? "定时" : "手动"}</span><span>处理 {run.processed}</span></div>
              </button>
            ))}
            {!dashboard?.runs.length && <p className="text-xs text-gray-600 text-center py-5">暂无历史记录</p>}
          </div>
        </div>
      </div>

      {selectedRun && (
        <div className="mt-4 border border-[#333] rounded p-4 bg-[#202020]">
          <div className="flex items-center justify-between mb-2"><span className="text-sm text-white">执行日志</span><span className="text-[11px] text-gray-600">{selectedRun.run_id}</span></div>
          <div className="max-h-52 overflow-y-auto space-y-1 font-mono text-[11px]">
            {(dashboard?.events || []).map((event) => (
              <div key={`${event.seq}-${event.created_at}`} className="flex gap-2"><span className="text-gray-600 shrink-0">{formatRunTime(event.created_at)}</span><span className={event.level === "error" ? "text-red-300" : event.level === "warning" ? "text-amber-300" : "text-gray-300"}>{event.message}</span></div>
            ))}
            {!dashboard?.events.length && <p className="text-gray-600">暂无日志</p>}
          </div>
        </div>
      )}
      <div className="mt-3 text-[11px] text-gray-600 flex items-center gap-1"><TriangleAlert size={12} />应用重启后，未完成任务会被标记为失败；可从历史记录重新运行。</div>
    </section>
  );
}
