import Link from "next/link";

/**
 * 数字分页选择器（1 2 … N 上一页/下一页），视觉对齐站内 pill 风格。
 *
 * 两种用法：
 * - 传 buildHref：渲染为 <Link>（/all、标签页等 SSR 分页，蜘蛛可爬）
 * - 传 onNavigate：渲染为按钮（首页客户端跳页）
 */

interface PaginationNavProps {
  current: number;
  total: number;
  buildHref?: (page: number) => string;
  onNavigate?: (page: number) => void;
  /** 按钮模式下跳页进行中时禁用交互 */
  disabled?: boolean;
  ariaLabel?: string;
}

type PageItem = { kind: "page"; page: number } | { kind: "gap" };

/** 页码窗口：首页、末页、当前页±1，间隙插省略号 */
function pageItems(current: number, total: number): PageItem[] {
  const wanted = new Set([1, total, current - 1, current, current + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const items: PageItem[] = [];
  let prev = 0;
  for (const page of pages) {
    if (page - prev > 1) items.push({ kind: "gap" });
    items.push({ kind: "page", page });
    prev = page;
  }
  return items;
}

export function PaginationNav({
  current,
  total,
  buildHref,
  onNavigate,
  disabled = false,
  ariaLabel = "分页",
}: PaginationNavProps) {
  if (total <= 1) return null;

  const pillBase =
    "inline-flex h-9 min-w-9 items-center justify-center rounded-full px-3 text-sm transition-colors";
  const idle = "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white";
  const active = "bg-white text-black font-medium";

  const renderItem = (item: PageItem, index: number) => {
    if (item.kind === "gap") {
      return (
        <span key={`gap-${index}`} className="px-1 text-gray-600" aria-hidden>
          …
        </span>
      );
    }
    const { page } = item;
    if (page === current) {
      return (
        <span key={page} aria-current="page" className={`${pillBase} ${active}`}>
          {page}
        </span>
      );
    }
    if (buildHref) {
      return (
        <Link key={page} href={buildHref(page)} className={`${pillBase} ${idle}`}>
          {page}
        </Link>
      );
    }
    return (
      <button
        key={page}
        onClick={() => onNavigate?.(page)}
        disabled={disabled}
        className={`${pillBase} ${idle} disabled:opacity-50`}
      >
        {page}
      </button>
    );
  };

  const renderStep = (target: number, label: string) => {
    if (buildHref) {
      return (
        <Link href={buildHref(target)} className={`${pillBase} px-4 ${idle}`}>
          {label}
        </Link>
      );
    }
    return (
      <button
        onClick={() => onNavigate?.(target)}
        disabled={disabled}
        className={`${pillBase} px-4 ${idle} disabled:opacity-50`}
      >
        {label}
      </button>
    );
  };

  return (
    <nav aria-label={ariaLabel} className="flex flex-wrap items-center justify-center gap-2">
      {current > 1 && renderStep(current - 1, "上一页")}
      {pageItems(current, total).map(renderItem)}
      {current < total && renderStep(current + 1, "下一页")}
    </nav>
  );
}
