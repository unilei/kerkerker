"use client";

import { useState, useEffect } from "react";
import { ExternalLink, HardDrive } from "lucide-react";
import {
  PAN_BRAND_CONFIGS,
  type PanResource,
} from "@/types/pan-resource";

interface PanResourceSectionProps {
  doubanId: string;
}

/**
 * 网盘资源区块（影片详情页）
 *
 * 从 /api/pan-resources?douban_id= 读取管理端录入的网盘分享链接，
 * 无数据时不渲染任何内容。
 */
export function PanResourceSection({ doubanId }: PanResourceSectionProps) {
  const [resources, setResources] = useState<PanResource[]>([]);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(
          `/api/pan-resources?douban_id=${encodeURIComponent(doubanId)}`
        );
        const result = await response.json();
        if (cancelled) return;
        if (result.code === 200 && result.data?.resources) {
          setResources(result.data.resources);
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
  }, [doubanId]);

  // 未加载完成或没有资源时整个区块隐藏
  if (!isReady || resources.length === 0) {
    return null;
  }

  return (
    <div className="mt-8 bg-[#121212]/40 backdrop-blur-2xl rounded-3xl border border-white/5 p-6 md:p-8 shadow-2xl shadow-black/20">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-white flex items-center gap-3">
          <span className="w-1 h-6 bg-red-600 rounded-full" />
          网盘资源
        </h2>
        <div className="text-sm text-gray-400 bg-black/20 px-3 py-1 rounded-full border border-white/5">
          共 <span className="text-white font-bold">{resources.length}</span>{" "}
          个资源
        </div>
      </div>

      <div className="space-y-2 md:space-y-3">
        {resources.map((resource) => {
          const brandConfig = PAN_BRAND_CONFIGS[resource.brand];
          return (
            <a
              key={resource.id}
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 md:gap-4 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 rounded-xl px-4 py-3 transition-all group"
            >
              <span
                className={`w-9 h-9 rounded-full ${brandConfig.badgeClass} flex items-center justify-center text-white text-sm font-bold shrink-0`}
              >
                {brandConfig.shortName}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-white truncate group-hover:text-red-400 transition-colors">
                  {resource.title}
                </span>
                <span className="block text-xs text-gray-500 mt-0.5 truncate">
                  {[
                    brandConfig.name,
                    resource.size,
                    resource.format,
                    resource.updated_at?.slice(0, 10),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <ExternalLink className="w-4 h-4 text-gray-600 group-hover:text-red-400 transition-colors shrink-0" />
            </a>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-gray-600 flex items-center gap-1.5">
        <HardDrive className="w-3.5 h-3.5" />
        网盘资源来自网络整理，点击可在对应网盘中转存或在线播放
      </p>
    </div>
  );
}
