"use client";

import { useMemo } from "react";

export interface TagGroup {
  category: string;
  tags: Array<{ tag: string; count?: number }>;
}

interface TagCloudProps {
  groups: TagGroup[];
  activeTag?: string;
  onSelect?: (tag: string | null) => void;
}

/**
 * 短剧标签云（分组彩色 chips）
 *
 * 颜色按组主题色循环（接近源站标签云观感），点击交给 onSelect；
 * 传 activeTag 高亮当前选中。组内 chips 用 flex-wrap 自适应。
 */

const GROUP_COLORS = [
  { text: "text-red-400", ring: "border-red-500/40", bg: "bg-red-500/10" },
  { text: "text-sky-400", ring: "border-sky-500/40", bg: "bg-sky-500/10" },
  { text: "text-emerald-400", ring: "border-emerald-500/40", bg: "bg-emerald-500/10" },
  { text: "text-orange-400", ring: "border-orange-500/40", bg: "bg-orange-500/10" },
  { text: "text-fuchsia-400", ring: "border-fuchsia-500/40", bg: "bg-fuchsia-500/10" },
];

export function TagCloud({ groups, activeTag, onSelect }: TagCloudProps) {
  const flat = useMemo(
    () => groups.map((group, index) => ({ ...group, color: GROUP_COLORS[index % GROUP_COLORS.length] })),
    [groups]
  );

  if (flat.length === 0) return null;

  return (
    <div className="w-full">
      {flat.map((group) => (
        <div key={group.category} className="mb-3 flex items-start gap-3">
          <span className="shrink-0 mt-1 px-2 py-0.5 bg-white/10 rounded text-xs text-gray-300 whitespace-nowrap">
            {group.category}
          </span>
          <div className="flex flex-wrap gap-2">
            {group.tags.map(({ tag, count }) => {
              const active = tag === activeTag;
              return (
                <button
                  key={tag}
                  onClick={() => onSelect?.(active ? null : tag)}
                  className={`px-2.5 py-1 rounded-full border text-xs transition-all hover:scale-105 ${
                    active
                      ? "bg-white text-black border-white font-bold"
                      : `${group.color.text} ${group.color.ring} ${group.color.bg} hover:bg-white/10`
                  }`}
                >
                  {tag}
                  {count !== undefined ? (
                    <span className="ml-1 opacity-60">{count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
