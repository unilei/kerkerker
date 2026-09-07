"use client";

import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Menu, X, Home, ChevronDown, Search } from "lucide-react";
import { useLocale } from "@/components/providers/locale-provider";
import { LanguageSwitcher } from "@/components/home/LanguageSwitcher";
import { SITE_NAME, tagPath } from "@/lib/seo";
import {
  TAG_MENU_GROUPS,
  KNOWN_SOURCE_CATEGORIES,
} from "@/lib/short-drama/tag-menu";

interface TagMenuItem {
  label: string;
  labelEn: string;
  tags: Array<{ tag: string; count?: number }>;
  dotClass: string;
  textClass: string;
}

type LiveTagGroup = { category: string; tags: Array<{ tag: string; count?: number }> };

/** 静态快照即时渲染，挂载后用 /api/short-dramas/tags 水合（动态分组 + 命中计数） */
function mergeTagMenu(live: LiveTagGroup[]): TagMenuItem[] {
  const liveByCategory = new Map(live.map((group) => [group.category, group.tags]));
  const merged: TagMenuItem[] = TAG_MENU_GROUPS.map((group) => {
    const tags = liveByCategory.get(group.sourceCategory);
    return {
      label: group.label,
      labelEn: group.labelEn,
      dotClass: group.dotClass,
      textClass: group.textClass,
      tags: (tags ?? group.tags).map((entry) =>
        typeof entry === "string" ? { tag: entry } : entry
      ),
    };
  });
  // 库里新增的、快照没有的分类（含「其他标签」兜底组）尾随展示；
  // 快照已知但刻意不进菜单的分类（单字标签）跳过
  const shownCategories = new Set(TAG_MENU_GROUPS.map((group) => group.sourceCategory));
  for (const [category, tags] of liveByCategory) {
    if (shownCategories.has(category) || KNOWN_SOURCE_CATEGORIES.includes(category)) {
      continue;
    }
    merged.push({
      label: category,
      labelEn: category,
      tags: tags.map((entry) => (typeof entry === "string" ? { tag: entry } : entry)),
      dotClass: "bg-gray-500",
      textClass: "text-gray-300",
    });
  }
  return merged;
}

const STATIC_TAG_MENU: TagMenuItem[] = TAG_MENU_GROUPS.map((group) => ({
  label: group.label,
  labelEn: group.labelEn,
  dotClass: group.dotClass,
  textClass: group.textClass,
  tags: group.tags.map((tag) => ({ tag })),
}));

const TAGS_HREF = (tag: string) => tagPath(tag);

/** 姊妹站外链：爱盼主站（4K 资源站） */
const AIPAN_4K_URL = "https://www.aipan.me";

/** 分组标签 chip：统一灰底，当前筛选中的词点亮 */
function TagChip({
  tag,
  count,
  activeTag,
  size = "sm",
  onClickClose,
}: {
  tag: string;
  count?: number;
  activeTag: string | null;
  size?: "sm" | "md";
  onClickClose?: () => void;
}) {
  const active = activeTag === tag;
  return (
    <Link
      href={TAGS_HREF(tag)}
      onClick={onClickClose}
      aria-current={active ? "true" : undefined}
      className={`inline-flex items-center rounded-full transition-colors ${
        size === "md" ? "px-3 py-1.5 text-sm" : "px-2.5 py-1 text-xs"
      } ${
        active
          ? "bg-red-600 text-white font-medium"
          : "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
      } focus-visible:outline focus-visible:outline-1 focus-visible:outline-red-500`}
    >
      {tag}
      {count !== undefined && !active ? (
        <span className="ml-1 text-[9px] opacity-50 tabular-nums">{count}</span>
      ) : null}
    </Link>
  );
}

interface NavbarProps {
  scrolled: boolean;
  onSearchOpen: () => void;
}

export function Navbar({ scrolled, onSearchOpen }: NavbarProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tagMenu, setTagMenu] = useState<TagMenuItem[]>(STATIC_TAG_MENU);
  const [panelMounted, setPanelMounted] = useState(false);
  const activeTag = useSearchParams().get("tag");
  useEffect(() => {
    // setTimeout 而非 rAF:后台/内嵌 WebView 标签页里 rAF 会冻结
    const id = setTimeout(() => setPanelMounted(true), 0);
    return () => clearTimeout(id);
  }, []);
  const { locale } = useLocale();
  const isEnglish = locale === "en-US";

  // 防止移动端菜单打开时页面滚动
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isMobileMenuOpen]);

  // 标签菜单动态水合：分组/计数来自本地库聚合（失败则保持静态快照）
  useEffect(() => {
    let cancelled = false;
    fetch("/api/short-dramas/tags", { signal: AbortSignal.timeout(8000) })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled && payload.code === 200 && Array.isArray(payload.data?.tag_groups)) {
          setTagMenu(mergeTagMenu(payload.data.tag_groups));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Escape 关闭面板/抽屉
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenGroup(null);
      setIsMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openWithDelay = (category: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpenGroup(category);
  };
  const closeWithDelay = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenGroup(null), 200);
  };

  const navLink =
    "text-gray-400 hover:text-white transition-colors text-sm font-medium";

  return (
    <>
      <nav
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled
            ? "bg-black"
            : "bg-gradient-to-b from-black/80 to-transparent"
        }`}
      >
        <div className="px-4 md:px-12 py-3 md:py-4 flex items-center justify-between">
          {/* 左侧：汉堡菜单（移动端）+ Logo + 主导航 */}
          <div className="flex items-center space-x-2 md:space-x-8">
            {/* 汉堡菜单按钮 - 仅移动端 */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden p-2 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="菜单"
              aria-expanded={isMobileMenuOpen}
            >
              {isMobileMenuOpen ? (
                <X className="w-6 h-6 text-white" />
              ) : (
                <Menu className="w-6 h-6 text-white" />
              )}
            </button>

            {/* Logo */}
            <Link
              href="/"
              onClick={() => setIsMobileMenuOpen(false)}
              className="flex items-center gap-1"
            >
              <img
                className="w-8 h-8 md:w-10 md:h-10"
                src="/logo.png"
                alt="logo"
              />
              <span className="text-red-600 text-xl md:text-2xl lg:text-3xl font-bold tracking-tight hover:text-red-500 transition-colors">
                {SITE_NAME}
              </span>
            </Link>

            {/* 主导航 - 桌面端 */}
            <div className="hidden md:flex items-center space-x-6">
              <Link
                href="/"
                className={`${navLink} ${!activeTag ? "text-white" : ""}`}
              >
                {isEnglish ? "Home" : "首页"}
              </Link>

              {/* 四个分组各为一级导航项：女频/男频/题材/爽点，各自下拉子分类。
                  面板对齐触发按钮：首组左对齐、末组右对齐、中间组居中，
                  md 窄屏下首尾组也不会溢出视口 */}
              {tagMenu.map((group, groupIndex) => {
                const isOpen = openGroup === group.label;
                // 当前筛选词属于该组时点亮（水合前按静态快照判断，足够近似）
                const hasActiveTag = tagMenu
                  .find((g) => g.label === group.label)
                  ?.tags.some(({ tag }) => tag === activeTag);
                const panelAlign =
                  groupIndex === 0
                    ? "left-0"
                    : groupIndex === tagMenu.length - 1
                      ? "right-0"
                      : "left-1/2 -translate-x-1/2";
                return (
                  <div
                    key={group.label}
                    className="relative"
                    onMouseEnter={() => openWithDelay(group.label)}
                    onMouseLeave={closeWithDelay}
                  >
                    <button
                      className={`${navLink} flex items-center gap-1 ${
                        hasActiveTag ? "text-white" : ""
                      }`}
                      aria-expanded={isOpen}
                      onClick={() => setOpenGroup(isOpen ? null : group.label)}
                    >
                      {isEnglish ? group.labelEn : group.label}
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    {/* 下拉面板：该组的全部子分类标签 */}
                    <div
                      className={`absolute top-full pt-3 transition-opacity duration-200 ${panelAlign} ${
                        isOpen ? "opacity-100 visible" : "opacity-0 invisible"
                      }`}
                    >
                      <div className="w-[360px] bg-[#141414]/98 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl shadow-black/60 p-5">
                        <div className="flex items-center gap-1.5 mb-3">
                          <span className={`w-1.5 h-1.5 rounded-full ${group.dotClass}`} />
                          <span className={`text-xs font-bold ${group.textClass}`}>
                            {isEnglish ? group.labelEn : group.label}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {panelMounted &&
                            group.tags.map(({ tag, count }) => (
                              <TagChip
                                key={tag}
                                tag={tag}
                                count={count}
                                activeTag={activeTag}
                                size="md"
                                onClickClose={() => setOpenGroup(null)}
                              />
                            ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* 姊妹站外链：爱盼-4K资源（新窗口打开） */}
              <a
                href={AIPAN_4K_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={`${navLink} flex items-center gap-1`}
              >
                {isEnglish ? "AiPan 4K" : "爱盼-4K资源"}
                <svg className="w-3 h-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            </div>
          </div>

          {/* 右侧功能区 */}
          <div className="flex items-center space-x-1 md:space-x-2">
            {/* 搜索：桌面端胶囊按钮，移动端 icon */}
            <button
              onClick={onSearchOpen}
              className="flex items-center gap-2 pl-3 pr-2 md:pr-3 py-1.5 md:py-2 rounded-full border border-white/15 bg-white/5 hover:bg-white/10 hover:border-white/25 transition-colors"
              aria-label={isEnglish ? "Search" : "搜索"}
            >
              <Search className="w-4 h-4 md:w-4.5 md:h-4.5 text-gray-300" />
              <span className="hidden md:inline text-sm text-gray-400">
                {isEnglish ? "Search dramas" : "搜索短剧"}
              </span>
              <kbd className="hidden lg:inline text-[10px] text-gray-500 border border-white/15 rounded px-1.5 py-0.5">
                /
              </kbd>
            </button>
            <LanguageSwitcher compact />
          </div>
        </div>
      </nav>

      {/* 移动端侧边栏菜单(挂载后渲染:隐形全屏遮罩参与水合同样会让 React 静默挂起) */}
      {panelMounted && (
      <div
        className={`md:hidden fixed inset-0 z-[60] transition-opacity duration-300 ${
          isMobileMenuOpen
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
      >
        {/* 背景遮罩 */}
        <div
          className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          onClick={() => setIsMobileMenuOpen(false)}
        />

        {/* 侧边栏内容 */}
        <div
          className={`absolute top-0 left-0 h-full w-[300px] bg-gradient-to-b from-gray-900 to-black shadow-2xl transform transition-transform duration-300 ease-out ${
            isMobileMenuOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {/* 侧边栏头部 */}
          <div className="p-6 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <img className="w-10 h-10" src="/logo.png" alt="logo" />
              <h2 className="text-red-600 text-2xl font-bold tracking-tight">
                {SITE_NAME}
              </h2>
            </div>
            {/* 搜索入口 */}
            <button
              onClick={() => {
                setIsMobileMenuOpen(false);
                onSearchOpen();
              }}
              className="mt-4 w-full flex items-center gap-2 px-3 py-2.5 rounded-full border border-white/15 bg-white/5 text-left"
            >
              <Search className="w-4 h-4 text-gray-400" />
              <span className="text-sm text-gray-400">
                {isEnglish ? "Search dramas" : "搜索短剧"}
              </span>
            </button>
          </div>

          {/* 导航菜单 */}
          <nav className="p-4 space-y-1 overflow-y-auto max-h-[calc(100vh-220px)]">
            <Link
              href="/"
              onClick={() => setIsMobileMenuOpen(false)}
              className={`flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200 group text-gray-300 hover:text-white hover:bg-white/10 ${
                !activeTag ? "bg-white/5 text-white" : ""
              }`}
            >
              <Home className="w-5 h-5 text-gray-400 group-hover:text-red-500 transition-colors" />
              <span className="text-base font-medium">
                {isEnglish ? "Home" : "首页"}
              </span>
            </Link>

            {/* 姊妹站外链：爱盼-4K资源（新窗口打开） */}
            <a
              href={AIPAN_4K_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setIsMobileMenuOpen(false)}
              className="flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200 group text-gray-300 hover:text-white hover:bg-white/10"
            >
              <svg className="w-5 h-5 text-gray-400 group-hover:text-red-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              <span className="text-base font-medium">
                {isEnglish ? "AiPan 4K" : "爱盼-4K资源"}
              </span>
            </a>

            {/* 分组手风琴：女频/男频/题材/爽点各自二级菜单 */}
            {tagMenu.map((group) => {
              const expanded = mobileExpanded === group.label;
              const hasActiveTag = group.tags.some(({ tag }) => tag === activeTag);
              return (
                <div key={group.label} className="pt-1">
                  <button
                    onClick={() =>
                      setMobileExpanded(expanded ? null : group.label)
                    }
                    aria-expanded={expanded}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-lg transition-all ${
                      hasActiveTag
                        ? "bg-white/5 text-white"
                        : "text-gray-300 hover:text-white hover:bg-white/10"
                    }`}
                  >
                    <span className="flex items-center space-x-3">
                      <span
                        className={`w-2 h-2 rounded-full ${group.dotClass}`}
                      />
                      <span className="text-base font-medium">
                        {isEnglish ? group.labelEn : group.label}
                      </span>
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${
                        expanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {expanded && (
                    <div className="mt-1 px-4 pb-2">
                      <div className="flex flex-wrap gap-2">
                        {group.tags.map(({ tag, count }) => (
                          <TagChip
                            key={tag}
                            tag={tag}
                            count={count}
                            activeTag={activeTag}
                            size="md"
                            onClickClose={() => setIsMobileMenuOpen(false)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          {/* 侧边栏底部 */}
          <div className="absolute bottom-0 left-0 right-0 p-6 border-t border-gray-800">
            <p className="text-xs text-gray-500 text-center">
              © 2026 {SITE_NAME} · 短剧信息聚合与导航
            </p>
          </div>
        </div>
      </div>
      )}
    </>
  );
}
