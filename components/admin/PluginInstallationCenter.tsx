"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleAlert,
  Download,
  Info,
  Loader2,
  Package,
  Power,
  RefreshCw,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import type { ConfirmState, ToastState } from "./types";

type InstallationStatus = "available" | "installed" | "enabled" | "disabled" | "failed";
type InstallationAction = "install" | "enable" | "disable" | "uninstall" | "retry";

interface PluginCapability {
  id?: string;
  version?: string;
  features?: readonly string[];
}

interface PluginInstallation {
  status: InstallationStatus;
  pluginVersion?: string;
  installedAt?: string;
  enabledAt?: string;
  disabledAt?: string;
  failedAt?: string;
  uninstalledAt?: string;
  updatedAt?: string;
  error?: string;
}

interface PluginRow {
  id: string;
  name: string;
  version: string;
  contractVersion?: string;
  capabilities: readonly (PluginCapability | string)[];
  locales: readonly string[];
  installation: PluginInstallation;
}

interface Props {
  onShowToast: (toast: ToastState) => void;
  onShowConfirm: (confirm: ConfirmState) => void;
}

const STATUS_LABELS: Record<InstallationStatus, string> = {
  available: "未安装",
  installed: "已安装 · 未启用",
  enabled: "已启用",
  disabled: "已停用",
  failed: "安装失败",
};

const STATUS_CLASSES: Record<InstallationStatus, string> = {
  available: "text-gray-400 border-[#444]",
  installed: "text-amber-300 border-amber-900/70",
  enabled: "text-emerald-300 border-emerald-900/70",
  disabled: "text-gray-300 border-[#555]",
  failed: "text-red-300 border-red-900/70",
};

const CAPABILITY_LABELS: Record<string, string> = {
  "content.catalog": "内容目录",
  "content.calendar": "日历",
  "content.detail": "内容详情",
  "content.search": "内容搜索",
  "resource.cloud-drive": "网盘资源",
  "resource.playback": "播放资源",
  "interaction.danmu": "弹幕",
  "asset.image": "图片",
  recommendation: "推荐",
};

function capabilityId(capability: PluginCapability | string): string {
  return typeof capability === "string" ? capability : capability.id || "";
}

function capabilityLabel(capability: PluginCapability | string): string {
  const id = capabilityId(capability);
  return CAPABILITY_LABELS[id] || id;
}

function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  return fallback;
}

function statusIcon(status: InstallationStatus) {
  if (status === "enabled") return Check;
  if (status === "failed") return CircleAlert;
  if (status === "disabled") return XCircle;
  return Package;
}

function normalizeStatus(value: unknown): InstallationStatus {
  return value === "installed" || value === "enabled" || value === "disabled" || value === "failed"
    ? value
    : "available";
}

function normalizeRows(value: unknown): PluginRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.version !== "string") {
      return [];
    }
    const rawInstallation = row.installation && typeof row.installation === "object"
      ? row.installation as Record<string, unknown>
      : {};
    const rawError = rawInstallation.error;
    const error = typeof rawError === "string"
      ? rawError
      : rawError && typeof rawError === "object" && "message" in rawError && typeof rawError.message === "string"
        ? rawError.message
        : undefined;
    return [{
      id: row.id,
      name: row.name,
      version: row.version,
      contractVersion: typeof row.contractVersion === "string" ? row.contractVersion : undefined,
      capabilities: Array.isArray(row.capabilities) ? row.capabilities as (PluginCapability | string)[] : [],
      locales: Array.isArray(row.locales) ? row.locales.filter((locale): locale is string => typeof locale === "string") : [],
      installation: {
        status: normalizeStatus(rawInstallation.status),
        pluginVersion: typeof (rawInstallation.pluginVersion ?? rawInstallation.plugin_version) === "string"
          ? rawInstallation.pluginVersion as string || rawInstallation.plugin_version as string
          : undefined,
        installedAt: typeof (rawInstallation.installedAt ?? rawInstallation.installed_at) === "string"
          ? rawInstallation.installedAt as string || rawInstallation.installed_at as string
          : undefined,
        enabledAt: typeof (rawInstallation.enabledAt ?? rawInstallation.enabled_at) === "string"
          ? rawInstallation.enabledAt as string || rawInstallation.enabled_at as string
          : undefined,
        disabledAt: typeof (rawInstallation.disabledAt ?? rawInstallation.disabled_at) === "string"
          ? rawInstallation.disabledAt as string || rawInstallation.disabled_at as string
          : undefined,
        failedAt: typeof (rawInstallation.failedAt ?? rawInstallation.failed_at) === "string"
          ? rawInstallation.failedAt as string || rawInstallation.failed_at as string
          : undefined,
        uninstalledAt: typeof (rawInstallation.uninstalledAt ?? rawInstallation.uninstalled_at) === "string"
          ? rawInstallation.uninstalledAt as string || rawInstallation.uninstalled_at as string
          : undefined,
        updatedAt: typeof (rawInstallation.updatedAt ?? rawInstallation.updated_at) === "string"
          ? rawInstallation.updatedAt as string || rawInstallation.updated_at as string
          : undefined,
        error,
      },
    }];
  });
}

function formatTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 19).replace("T", " ");
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function actionLabel(action: InstallationAction): string {
  return {
    install: "安装",
    enable: "启用",
    disable: "停用",
    uninstall: "卸载",
    retry: "重试安装",
  }[action];
}

function actionMessage(plugin: PluginRow, action: InstallationAction): string {
  if (action === "install") return `确认安装插件“${plugin.name}”吗？安装完成后还需要手动启用，未启用前不会调用插件。`;
  if (action === "enable") return `确认启用插件“${plugin.name}”吗？启用后该插件才可以被前台和任务调用。`;
  if (action === "disable") return `确认停用插件“${plugin.name}”吗？历史数据会保留，但新的调用会被阻止。`;
  if (action === "retry") return `确认重试安装插件“${plugin.name}”吗？`;
  return `确认卸载插件“${plugin.name}”吗？历史数据和审计记录会保留，但插件将停止提供能力。`;
}

export function PluginInstallationCenter({ onShowToast, onShowConfirm }: Props) {
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch("/api/plugins/installations", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.code !== 200) {
        throw new Error(extractMessage(body, "读取插件安装状态失败"));
      }
      setPlugins(normalizeRows(body.data?.plugins));
      setError(null);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "读取插件安装状态失败";
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => plugins.reduce<Record<string, number>>((result, plugin) => {
    result[plugin.installation.status] = (result[plugin.installation.status] || 0) + 1;
    return result;
  }, {}), [plugins]);

  const runAction = async (plugin: PluginRow, action: InstallationAction) => {
    const key = `${plugin.id}:${action}`;
    setBusyKey(key);
    try {
      const response = await fetch("/api/plugins/installations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          plugin_id: plugin.id,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.code !== 200) {
        throw new Error(extractMessage(body, `${actionLabel(action)}失败`));
      }
      onShowToast({ message: `插件已${actionLabel(action)}`, type: "success" });
      await load(true);
    } catch (actionError) {
      onShowToast({
        message: actionError instanceof Error ? actionError.message : `${actionLabel(action)}失败`,
        type: "error",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const requestAction = (plugin: PluginRow, action: InstallationAction) => {
    onShowConfirm({
      title: `${actionLabel(action)}插件`,
      message: actionMessage(plugin, action),
      danger: action === "uninstall",
      onConfirm: () => runAction(plugin, action),
    });
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#333] pb-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-medium text-white">
            <Package size={19} className="text-[#E50914]" />
            插件中心
          </h2>
          <p className="mt-1 text-xs text-gray-500">插件默认未安装。安装后仍需手动启用，只有已启用插件才允许被前台和任务调用。</p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading || refreshing || Boolean(busyKey)}
          className="inline-flex h-9 items-center gap-1.5 rounded border border-[#444] bg-[#252525] px-3 text-xs text-gray-200 hover:bg-[#303030] disabled:opacity-50"
          title="刷新插件安装状态"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-400">
        <span>共 {plugins.length} 个</span>
        <span className="text-emerald-300">已启用 {counts.enabled || 0}</span>
        <span className="text-amber-300">待启用 {(counts.installed || 0) + (counts.disabled || 0)}</span>
        <span className="text-red-300">失败 {counts.failed || 0}</span>
      </div>

      <div className="flex items-start gap-2 border border-sky-900/70 bg-sky-950/20 px-3 py-3 text-xs text-sky-200">
        <Info size={15} className="mt-0.5 shrink-0" />
        <p>卸载只移除插件的运行资格，不删除既有影片、网盘资源、图片镜像或审计记录。重新安装后可继续配置并启用。</p>
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 border border-red-900/60 bg-red-950/20 px-4 py-3 text-sm text-red-200">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="text-xs underline underline-offset-2">重试</button>
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" />正在读取插件状态…</div>
      ) : plugins.length === 0 ? (
        <div className="border border-dashed border-[#444] px-4 py-10 text-center text-sm text-gray-500">暂无可安装插件</div>
      ) : (
        <div className="overflow-x-auto border border-[#333] bg-[#181818]">
          <table className="min-w-[980px] w-full border-collapse text-left text-xs">
            <thead className="border-b border-[#333] bg-[#202020] text-gray-500">
              <tr>
                <th className="px-3 py-2.5 font-normal">插件</th>
                <th className="px-3 py-2.5 font-normal">能力</th>
                <th className="px-3 py-2.5 font-normal">语言</th>
                <th className="px-3 py-2.5 font-normal">安装状态</th>
                <th className="px-3 py-2.5 font-normal">更新时间</th>
                <th className="px-3 py-2.5 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((plugin) => {
                const status = plugin.installation.status;
                const StatusIcon = statusIcon(status);
                const busy = busyKey?.startsWith(`${plugin.id}:`) || false;
                const updatedAt = plugin.installation.updatedAt || plugin.installation.enabledAt || plugin.installation.installedAt;
                return (
                  <tr key={plugin.id} className="border-b border-[#2b2b2b] last:border-b-0 hover:bg-[#222]">
                    <td className="max-w-[290px] px-3 py-3 align-top">
                      <p className="truncate font-medium text-white" title={plugin.name}>{plugin.name}</p>
                      <p className="mt-1 truncate font-mono text-[10px] text-gray-600" title={plugin.id}>{plugin.id}</p>
                      <p className="mt-1 text-[10px] text-gray-500">v{plugin.version}{plugin.contractVersion ? ` · 契约 ${plugin.contractVersion}` : ""}</p>
                    </td>
                    <td className="max-w-[260px] px-3 py-3 align-top text-gray-400">
                      <div className="flex flex-wrap gap-1.5">
                        {plugin.capabilities.length > 0 ? plugin.capabilities.map((capability) => (
                          <span key={capabilityId(capability)} className="border border-[#444] px-1.5 py-1 text-[10px]" title={capabilityId(capability)}>
                            {capabilityLabel(capability)}
                          </span>
                        )) : <span className="text-gray-600">未声明</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-gray-400">{plugin.locales.length ? plugin.locales.join("、") : "-"}</td>
                    <td className="px-3 py-3 align-top">
                      <span className={`inline-flex items-center gap-1 border px-2 py-1 ${STATUS_CLASSES[status]}`}>
                        <StatusIcon size={13} />{STATUS_LABELS[status]}
                      </span>
                      {status === "failed" && plugin.installation.error && (
                        <p className="mt-1 max-w-[190px] text-[10px] text-red-300" title={plugin.installation.error}>{plugin.installation.error}</p>
                      )}
                      {status !== "enabled" && (
                        <p className="mt-1 text-[10px] text-gray-600">当前不可调用</p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 align-top text-gray-500">{formatTime(updatedAt) || "-"}</td>
                    <td className="whitespace-nowrap px-3 py-3 align-top text-right">
                      <div className="flex justify-end gap-1.5">
                        {status === "available" && (
                          <ActionButton icon={Download} label="安装" busy={busy} disabled={Boolean(busyKey)} onClick={() => requestAction(plugin, "install")} />
                        )}
                        {status === "failed" && (
                          <ActionButton icon={RotateCcw} label="重试" busy={busy} disabled={Boolean(busyKey)} onClick={() => requestAction(plugin, "retry")} />
                        )}
                        {(status === "installed" || status === "disabled") && (
                          <ActionButton icon={Power} label="启用" busy={busy} disabled={Boolean(busyKey)} onClick={() => requestAction(plugin, "enable")} primary />
                        )}
                        {status === "enabled" && (
                          <ActionButton icon={Power} label="停用" busy={busy} disabled={Boolean(busyKey)} onClick={() => requestAction(plugin, "disable")} />
                        )}
                        {status !== "available" && (
                          <ActionButton icon={Trash2} label="卸载" busy={busy} disabled={Boolean(busyKey)} onClick={() => requestAction(plugin, "uninstall")} danger />
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
    </section>
  );
}

function ActionButton({
  icon: Icon,
  label,
  busy,
  disabled,
  onClick,
  primary = false,
  danger = false,
}: {
  icon: typeof Download;
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  const classes = danger
    ? "border-red-900/70 text-red-200 hover:bg-red-950/40"
    : primary
      ? "border-[#E50914] bg-[#E50914] text-white hover:bg-[#f6121d]"
      : "border-[#555] text-gray-200 hover:bg-[#333]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] disabled:opacity-50 ${classes}`}
      title={label}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
      {label}
    </button>
  );
}
