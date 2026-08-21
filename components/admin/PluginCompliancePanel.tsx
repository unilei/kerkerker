"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  Check,
  CircleAlert,
  Clock3,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { ToastState } from "./types";

interface PluginPolicy {
  plugin_id: string;
  plugin_version: string;
  status: string;
  enabled: boolean;
  enforcement_mode: "audit" | "enforce";
  owner?: string;
  authorization_ref?: string;
  license?: string;
  legal_basis?: string;
  data_purpose?: string | string[];
  content_scope?: string | string[];
  terms_url?: string;
  retention_days?: number;
  correction_contact?: string | { email?: string; name?: string };
  takedown_contact?: string | { email?: string; name?: string };
}

interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  policy: PluginPolicy | null;
}

interface AuditEvent {
  event_id: string;
  action: string;
  plugin_id?: string;
  actor?: { type?: string; id?: string };
  reason?: string;
  created_at: string;
}

interface TakedownRecord {
  takedown_id: string;
  status: string;
  reason_code: string;
  reason: string;
  target: {
    type: string;
    content_id?: string;
    provider_id?: string;
    plugin_id?: string;
    resource_id?: string;
  };
  created_at: string;
}

interface Props {
  onShowToast: (toast: ToastState) => void;
}

const inputClass =
  "w-full bg-[#252525] border border-[#444] rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#E50914]";

function policyLabel(policy: PluginPolicy | null): string {
  if (!policy) return "待审批";
  if (!policy.enabled) return policy.status === "approved" ? "已停用" : policy.status;
  return policy.enforcement_mode === "enforce" ? "已启用 · 强制" : "已启用 · 审计";
}

function contactValue(value: PluginPolicy["takedown_contact"]): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.email || value.name || "";
}

export function PluginCompliancePanel({ onShowToast }: Props) {
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [takedowns, setTakedowns] = useState<TakedownRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [approval, setApproval] = useState({
    owner: "",
    authorization_ref: "",
    license: "",
    legal_basis: "",
    terms_url: "",
    content_scope: "",
    data_purpose: "",
    retention_days: "365",
    correction_contact: "",
    takedown_contact: "",
  });
  const [takedown, setTakedown] = useState({
    type: "content",
    id: "",
    reason_code: "rights-request",
    reason: "",
  });

  const selected = useMemo(
    () => plugins.find((plugin) => plugin.id === selectedId) || plugins[0],
    [plugins, selectedId]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [policyResponse, auditResponse, takedownResponse] = await Promise.all([
        fetch("/api/plugins/policy?limit=100", { cache: "no-store" }),
        fetch("/api/plugins/audit?limit=12", { cache: "no-store" }),
        fetch("/api/plugins/takedown?status=active&limit=12", { cache: "no-store" }),
      ]);
      const [policyBody, auditBody, takedownBody] = await Promise.all([
        policyResponse.json(),
        auditResponse.json(),
        takedownResponse.json(),
      ]);
      if (!policyResponse.ok || policyBody.code !== 200) {
        throw new Error(policyBody.message || "策略读取失败");
      }
      setPlugins(policyBody.data?.plugins || []);
      setEvents(auditResponse.ok && auditBody.code === 200 ? auditBody.data?.events || [] : []);
      setTakedowns(
        takedownResponse.ok && takedownBody.code === 200
          ? takedownBody.data?.records || []
          : []
      );
    } catch (error) {
      onShowToast({
        message: error instanceof Error ? error.message : "合规数据读取失败",
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [onShowToast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    const policy = selected.policy;
    setApproval({
      owner: policy?.owner || "",
      authorization_ref: policy?.authorization_ref || "",
      license: policy?.license || "",
      legal_basis: policy?.legal_basis && policy.legal_basis !== "operator-review-required"
        ? policy.legal_basis
        : "",
      terms_url: policy?.terms_url || "",
      content_scope: Array.isArray(policy?.content_scope)
        ? policy.content_scope.join(", ")
        : policy?.content_scope || "",
      data_purpose: Array.isArray(policy?.data_purpose)
        ? policy.data_purpose.join(", ")
        : policy?.data_purpose || "",
      retention_days: String(policy?.retention_days || 365),
      correction_contact: contactValue(policy?.correction_contact),
      takedown_contact: contactValue(policy?.takedown_contact),
    });
  }, [selected]);

  const postPolicy = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await fetch("/api/plugins/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          plugin_id: selected.id,
          plugin_version: selected.version,
          reason: extra.reason || (action === "approve" ? "管理员完成合规材料复核" : `管理员执行${action}`),
          ...extra,
        }),
      });
      const body = await response.json();
      if (!response.ok || body.code !== 200) throw new Error(body.message || "策略更新失败");
      onShowToast({ message: "插件策略已更新", type: "success" });
      setShowApproval(false);
      await load();
    } catch (error) {
      onShowToast({ message: error instanceof Error ? error.message : "策略更新失败", type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const submitApproval = async () => {
    await postPolicy("approve", {
      ...approval,
      data_purpose: approval.data_purpose.split(",").map((value) => value.trim()).filter(Boolean),
      content_scope: approval.content_scope.split(",").map((value) => value.trim()).filter(Boolean),
      retention_days: Number(approval.retention_days),
      enforcement_mode: "audit",
    });
  };

  const createTakedown = async () => {
    const id = takedown.id.trim();
    if (!id || !takedown.reason.trim()) {
      onShowToast({ message: "请填写目标 ID 和下架原因", type: "warning" });
      return;
    }
    setBusy(true);
    try {
      const targetKey =
        takedown.type === "content"
          ? "content_id"
          : takedown.type === "provider"
            ? "provider_id"
            : takedown.type === "plugin"
              ? "plugin_id"
              : "resource_id";
      const response = await fetch("/api/plugins/takedown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          target: { type: takedown.type, [targetKey]: id },
          reason_code: takedown.reason_code,
          reason: takedown.reason.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok || body.code !== 200) throw new Error(body.message || "下架失败");
      setTakedown((current) => ({ ...current, id: "", reason: "" }));
      onShowToast({ message: "下架记录已创建，公开读取已即时过滤", type: "success" });
      await load();
    } catch (error) {
      onShowToast({ message: error instanceof Error ? error.message : "下架失败", type: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-medium text-white">
            <ShieldCheck size={20} className="text-[#E50914]" />
            插件合规
          </h2>
          <p className="mt-1 text-sm text-gray-500">审批、启停、下架和审计均留存记录。当前运行模式由服务端策略控制。</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy}
          className="flex items-center gap-2 rounded border border-[#444] px-3 py-2 text-sm text-gray-300 hover:border-[#666] disabled:opacity-50"
          title="刷新合规状态"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      <section className="border-b border-[#333] pb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-gray-200">已注册插件</h3>
          <span className="text-xs text-gray-500">{plugins.length} 个</span>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-gray-500"><Loader2 size={16} className="animate-spin" />读取中</div>
        ) : (
          <div className="space-y-2">
            {plugins.map((plugin) => (
              <button
                type="button"
                key={`${plugin.id}:${plugin.version}`}
                onClick={() => setSelectedId(plugin.id)}
                className={`flex w-full flex-wrap items-center justify-between gap-3 border px-3 py-3 text-left transition-colors ${
                  selected?.id === plugin.id ? "border-[#E50914] bg-[#211718]" : "border-[#333] bg-[#181818] hover:border-[#555]"
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-white">{plugin.name}</span>
                  <span className="block truncate text-xs text-gray-600">{plugin.id} · v{plugin.version}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-gray-400">
                  {plugin.policy?.status === "approved" && plugin.policy.enabled ? <Check size={14} className="text-emerald-400" /> : <CircleAlert size={14} className="text-amber-400" />}
                  {policyLabel(plugin.policy)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {selected && (
        <section className="border-b border-[#333] pb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-gray-200">{selected.name}</h3>
              <p className="mt-1 text-xs text-gray-500">{selected.id} · {policyLabel(selected.policy)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!selected.policy || selected.policy.status !== "approved" ? (
                <button type="button" onClick={() => setShowApproval((value) => !value)} disabled={busy} className="flex items-center gap-2 rounded bg-[#E50914] px-3 py-2 text-sm text-white hover:bg-[#f6121d] disabled:opacity-50">
                  <ShieldCheck size={15} />填写审批
                </button>
              ) : selected.policy.enabled ? (
                <button type="button" onClick={() => void postPolicy("disable", { reason: "管理员临时停用插件" })} disabled={busy} className="flex items-center gap-2 rounded border border-[#555] px-3 py-2 text-sm text-gray-200 hover:border-[#888] disabled:opacity-50">
                  <Ban size={15} />停用
                </button>
              ) : (
                <button type="button" onClick={() => void postPolicy("enable", { reason: "管理员恢复插件" })} disabled={busy} className="flex items-center gap-2 rounded bg-[#E50914] px-3 py-2 text-sm text-white hover:bg-[#f6121d] disabled:opacity-50">
                  <Check size={15} />启用
                </button>
              )}
            </div>
          </div>

          {showApproval && (
            <div className="mt-4 grid gap-3 border border-[#333] bg-[#181818] p-4 sm:grid-cols-2">
              {([
                ["owner", "负责人"],
                ["authorization_ref", "授权/证据编号"],
                ["license", "许可证或合同"],
                ["legal_basis", "法律/合同依据"],
                ["terms_url", "条款 URL（HTTPS）"],
                ["content_scope", "内容范围（逗号分隔）"],
                ["data_purpose", "数据用途（逗号分隔）"],
                ["retention_days", "保留天数"],
                ["correction_contact", "纠错联系人"],
                ["takedown_contact", "下架联系人"],
              ] as const).map(([key, label]) => (
                <label key={key} className="space-y-1 text-xs text-gray-400">
                  {label}
                  <input
                    type={key === "retention_days" ? "number" : "text"}
                    min={key === "retention_days" ? 1 : undefined}
                    value={approval[key]}
                    onChange={(event) => setApproval((current) => ({ ...current, [key]: event.target.value }))}
                    className={inputClass}
                  />
                </label>
              ))}
              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <button type="button" onClick={() => void submitApproval()} disabled={busy} className="flex items-center gap-2 rounded bg-[#E50914] px-3 py-2 text-sm text-white hover:bg-[#f6121d] disabled:opacity-50">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}保存并审批
                </button>
                <span className="text-xs text-gray-600">审批后默认进入审计模式，切换强制模式需在部署配置中明确设置。</span>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="border-b border-[#333] pb-6">
        <div className="mb-3 flex items-center gap-2">
          <Ban size={17} className="text-amber-400" />
          <h3 className="text-sm font-medium text-gray-200">创建下架记录</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-[140px_1fr_180px]">
          <select value={takedown.type} onChange={(event) => setTakedown((current) => ({ ...current, type: event.target.value }))} className={inputClass}>
            <option value="content">内容身份</option>
            <option value="resource">资源</option>
            <option value="provider">来源插件</option>
            <option value="plugin">插件</option>
          </select>
          <input value={takedown.id} onChange={(event) => setTakedown((current) => ({ ...current, id: event.target.value }))} placeholder="目标 ID" className={inputClass} />
          <input value={takedown.reason_code} onChange={(event) => setTakedown((current) => ({ ...current, reason_code: event.target.value }))} placeholder="原因代码" className={inputClass} />
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <input value={takedown.reason} onChange={(event) => setTakedown((current) => ({ ...current, reason: event.target.value }))} placeholder="下架原因" className={`${inputClass} min-w-[220px] flex-1`} />
          <button type="button" onClick={() => void createTakedown()} disabled={busy} className="flex items-center gap-2 rounded border border-amber-700/60 px-3 py-2 text-sm text-amber-200 hover:border-amber-500 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}立即下架
          </button>
        </div>
        {takedowns.length > 0 && (
          <div className="mt-4 space-y-2 text-xs">
            {takedowns.slice(0, 6).map((record) => (
              <div key={record.takedown_id} className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-amber-700/60 pl-3 text-gray-400">
                <span>{record.target.type} · {record.target.content_id || record.target.resource_id || record.target.provider_id || record.target.plugin_id}</span>
                <span className="text-gray-600">{record.reason}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Clock3 size={17} className="text-gray-400" />
          <h3 className="text-sm font-medium text-gray-200">最近审计事件</h3>
        </div>
        {events.length === 0 ? (
          <p className="text-xs text-gray-600">暂无事件</p>
        ) : (
          <div className="divide-y divide-[#292929] border-y border-[#292929]">
            {events.slice(0, 8).map((event) => (
              <div key={event.event_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <span className="text-gray-300">{event.action}</span>
                <span className="text-gray-600">{event.plugin_id || event.actor?.id || "system"} · {event.created_at.slice(0, 19).replace("T", " ")}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
