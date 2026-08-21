"use client";

import { useState, useEffect, useCallback } from "react";
import { ExternalLink, HardDrive, Settings2, Copy, Check } from "lucide-react";
import {
  PAN_BRAND_CONFIGS,
  type PanResource,
} from "@/types/pan-resource";
import { BrandBadge } from "@/components/pan/BrandBadge";
import { PanResourceManager } from "@/components/pan/PanResourceManager";
import { Toast, ConfirmDialog } from "@/components/Toast";
import type { ToastState, ConfirmState } from "@/components/admin/types";

interface PanResourceSectionProps {
  doubanId: string;
  contentId?: string;
  title?: string;
  internalId?: number;
}

/**
 * 网盘资源区块（影片详情页）
 *
 * 从 /api/pan-resources?douban_id= 读取管理端录入的网盘分享链接，
 * 无数据时不渲染任何内容；管理员登录后可在此直接管理（内嵌面板）。
 */
export function PanResourceSection({
  doubanId,
  contentId,
  title,
  internalId,
}: PanResourceSectionProps) {
  const [resources, setResources] = useState<PanResource[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // 资源版本号：内嵌管理面板变更后刷新展示
  const [refreshFlag, setRefreshFlag] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const resourceQuery = contentId
          ? `content_id=${encodeURIComponent(contentId)}&douban_id=${encodeURIComponent(doubanId)}`
          : `douban_id=${encodeURIComponent(doubanId)}`;
        const [resourcesRes, authRes] = await Promise.all([
          fetch(`/api/pan-resources?${resourceQuery}`),
          fetch("/api/auth/me"),
        ]);
        const resourcesResult = await resourcesRes.json();
        const authResult = await authRes.json();
        if (cancelled) return;
        if (resourcesResult.code === 200 && resourcesResult.data?.resources) {
          setResources(resourcesResult.data.resources);
        }
        if (authResult.code === 200) {
          setIsAdmin(!!authResult.data?.authenticated);
        }
      } catch (error) {
        console.warn("获取网盘资源失败:", error);
      } finally {
        if (!cancelled) setIsReady(true);
      }
    };

    if (doubanId) {
      setIsReady(false);
      load();
    }

    return () => {
      cancelled = true;
    };
  }, [contentId, doubanId, refreshFlag]);

  // 复制提取码（不触发外层链接跳转）
  const handleCopyCode = useCallback(
    async (resource: PanResource) => {
      if (!resource.code) return;
      try {
        await navigator.clipboard.writeText(resource.code);
        setCopiedKey(resource.id);
        setTimeout(() => setCopiedKey(null), 1500);
      } catch {
        setToast({
          message: `提取码：${resource.code}（请手动复制）`,
          type: "info",
        });
      }
    },
    []
  );

  // 未加载完成或没有资源且非管理员时整个区块隐藏
  if (!isReady || (resources.length === 0 && !isAdmin)) {
    return null;
  }

  return (
    <div className="mt-8 bg-[#121212]/40 backdrop-blur-2xl rounded-3xl border border-white/5 p-6 md:p-8 shadow-2xl shadow-black/20">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-white flex items-center gap-3">
          <span className="w-1 h-6 bg-red-600 rounded-full" />
          网盘资源
        </h2>
        <div className="flex items-center gap-3">
          {resources.length > 0 && (
            <div className="text-sm text-gray-400 bg-black/20 px-3 py-1 rounded-full border border-white/5">
              共 <span className="text-white font-bold">{resources.length}</span>{" "}
              个资源
            </div>
          )}
          {isAdmin && (
            <button
              onClick={() => setShowManage((v) => !v)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors border ${
                showManage
                  ? "bg-red-600 border-red-600 text-white"
                  : "bg-white/5 border-white/10 text-gray-300 hover:text-white hover:bg-white/10"
              }`}
            >
              <Settings2 className="w-3.5 h-3.5" />
              {showManage ? "收起管理" : "管理"}
            </button>
          )}
        </div>
      </div>

      {/* 管理员内嵌管理面板 */}
      {isAdmin && showManage && (
        <div className="mb-6 bg-white/[0.03] border border-white/10 rounded-2xl p-4">
          <PanResourceManager
            movie={{
              douban_id: doubanId,
              content_id: contentId,
              title: title || doubanId,
              internal_id: internalId,
            }}
            onShowToast={setToast}
            onShowConfirm={setConfirm}
            onChanged={() => setRefreshFlag((v) => v + 1)}
          />
        </div>
      )}

      {resources.length > 0 && (
        <div className="space-y-2 md:space-y-3">
          {resources.map((resource) => {
            const brandConfig = PAN_BRAND_CONFIGS[resource.brand];
            return (
              <a
                key={resource.id}
                href={resource.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 md:gap-4 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/15 rounded-xl px-4 py-3 transition-all group"
              >
                <BrandBadge brand={resource.brand} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-white truncate group-hover:text-red-400 transition-colors">
                    {resource.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                    <span className={`text-xs ${brandConfig.textClass}`}>
                      {brandConfig.name}
                    </span>
                    {resource.size && (
                      <span className="text-[10px] text-gray-300 bg-white/10 px-1.5 py-0.5 rounded">
                        {resource.size}
                      </span>
                    )}
                    {resource.format && (
                      <span className="text-[10px] text-gray-300 bg-white/10 px-1.5 py-0.5 rounded">
                        {resource.format}
                      </span>
                    )}
                    {resource.note && (
                      <span className="text-[10px] text-amber-300/90 bg-amber-500/10 px-1.5 py-0.5 rounded">
                        {resource.note}
                      </span>
                    )}
                    {resource.code && (
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleCopyCode(resource);
                        }}
                        className="text-[10px] text-sky-300 bg-sky-500/10 hover:bg-sky-500/25 px-1.5 py-0.5 rounded flex items-center gap-1 transition-colors"
                        title="点击复制提取码"
                      >
                        {copiedKey === resource.id ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        {copiedKey === resource.id
                          ? "已复制"
                          : `提取码 ${resource.code}`}
                      </button>
                    )}
                    <span className="text-[10px] text-gray-600">
                      {resource.updated_at?.slice(0, 10)}
                    </span>
                  </span>
                </span>
                <ExternalLink className="w-4 h-4 text-gray-600 group-hover:text-red-400 transition-colors shrink-0" />
              </a>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-gray-600 flex items-center gap-1.5">
        <HardDrive className="w-3.5 h-3.5" />
        网盘资源来自网络整理，点击跳转对应网盘转存或查看
      </p>

      {/* 管理面板用的 Toast / 确认框 */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
          danger={confirm.danger}
        />
      )}
    </div>
  );
}
