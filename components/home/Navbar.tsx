"use client";

import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { Menu, X, Home, ChevronDown, Flame, LayoutGrid } from "lucide-react";
import { useLocale } from "@/components/providers/locale-provider";
import { LanguageSwitcher } from "@/components/home/LanguageSwitcher";
import { SITE_NAME } from "@/lib/seo";
import {
  TAG_MENU_GROUPS,
  TAG_QUICK_LINKS,
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

  const openWithDelay = (category: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpenGroup(category);
  };
  const closeWithDelay = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenGroup(null), 120);
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
          {/* 左侧：汉堡菜单（移动端）+ Logo */}
          <div className="flex items-center space-x-2 md:space-x-8">
            {/* 汉堡菜单按钮 - 仅移动端 */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden p-2 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="菜单"
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

            {/* 导航链接 - 桌面端 */}
            <div className="hidden md:flex items-center space-x-6">
              <Link href="/" className={navLink}>
                {isEnglish ? "Home" : "首页"}
              </Link>

              {/* 一级热门题材直链 */}
              {TAG_QUICK_LINKS.map(({ tag, label, labelEn }) => (
                <Link
                  key={tag}
                  href={`/?tag=${encodeURIComponent(tag)}`}
                  className={navLink}
                >
                  {isEnglish ? labelEn : label}
                </Link>
              ))}

              {/* 分类二级菜单：hover 展开 */}
              <div
                className="relative"
                onMouseEnter={() => openWithDelay("__tags__")}
                onMouseLeave={closeWithDelay}
              >
                <button
                  className={`${navLink} flex items-center gap-1`}
                  aria-expanded={openGroup === "__tags__"}
                  onClick={() =>
                    setOpenGroup(openGroup === "__tags__" ? null : "__tags__")
                  }
                >
                  {isEnglish ? "Categories" : "分类"}
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform ${
                      openGroup === "__tags__" ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {/* 下拉面板：女频/男频/题材/爽点 */}
                <div
                  className={`absolute left-1/2 -translate-x-1/2 top-full pt-3 transition-all duration-200 ${
                    openGroup === "__tags__"
                      ? "opacity-100 visible translate-y-0"
                      : "opacity-0 invisible -translate-y-1"
                  }`}
                >
                  <div className="w-[560px] bg-[#141414]/98 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl shadow-black/60 p-5 grid grid-cols-2 gap-x-6 gap-y-4">
                    {panelMounted && tagMenu.map((group) => (
                      <div key={group.label}>
                        <div className="flex items-center gap-1.5 mb-2">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${group.dotClass}`}
                          />
                          <span className="text-xs font-bold text-gray-300">
                            {isEnglish ? group.labelEn : group.label}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                          {group.tags.map(({ tag, count }) => (
                            <Link
                              key={tag}
                              href={`/?tag=${encodeURIComponent(tag)}`}
                              onClick={() => setOpenGroup(null)}
                              className={`text-xs ${group.textClass} hover:text-white hover:underline underline-offset-2 transition-colors`}
                            >
                              {tag}
                              {count !== undefined ? (
                                <span className="ml-0.5 text-[9px] opacity-50">
                                  {count}
                                </span>
                              ) : null}
                            </Link>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 右侧功能区 */}
          <div className="flex items-center space-x-1 md:space-x-2">
            {/* 搜索按钮 */}
            <button
              onClick={onSearchOpen}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
              aria-label={isEnglish ? "Search" : "搜索"}
            >
              <svg
                className="w-5 h-5 md:w-6 md:h-6 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
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
          className={`absolute top-0 left-0 h-full w-[280px] bg-gradient-to-b from-gray-900 to-black shadow-2xl transform transition-transform duration-300 ease-out ${
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
            <div className="mt-4">
              <LanguageSwitcher />
            </div>
          </div>

          {/* 导航菜单 */}
          <nav className="p-4 space-y-2 overflow-y-auto max-h-[calc(100vh-140px)]">
            <Link
              href="/"
              onClick={() => setIsMobileMenuOpen(false)}
              className="flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200 group text-gray-300 hover:text-white hover:bg-white/10"
            >
              <Home className="w-5 h-5 text-gray-400 group-hover:text-red-500 transition-colors" />
              <span className="text-base font-medium">
                {isEnglish ? "Home" : "首页"}
              </span>
            </Link>

            {/* 一级热门题材直链 */}
            {TAG_QUICK_LINKS.map(({ tag, label, labelEn }) => (
              <Link
                key={tag}
                href={`/?tag=${encodeURIComponent(tag)}`}
                onClick={() => setIsMobileMenuOpen(false)}
                className="flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200 group text-gray-300 hover:text-white hover:bg-white/10"
              >
                <Flame className="w-5 h-5 text-gray-400 group-hover:text-red-500 transition-colors" />
                <span className="text-base font-medium">
                  {isEnglish ? labelEn : label}
                </span>
              </Link>
            ))}

            {/* 分类手风琴（移动端二级菜单） */}
            <div>
              <button
                onClick={() =>
                  setMobileExpanded(mobileExpanded === "__tags__" ? null : "__tags__")
                }
                className="w-full flex items-center justify-between px-4 py-3 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-all"
              >
                <span className="flex items-center space-x-3">
                  <LayoutGrid className="w-5 h-5 text-gray-400" />
                  <span className="text-base font-medium">
                    {isEnglish ? "Categories" : "分类"}
                  </span>
                </span>
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${
                    mobileExpanded === "__tags__" ? "rotate-180" : ""
                  }`}
                />
              </button>

              {mobileExpanded === "__tags__" && (
                <div className="mt-1 space-y-3 px-2 pb-2">
                  {tagMenu.map((group) => (
                    <div key={group.label} className="px-2">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${group.dotClass}`}
                        />
                        <span className="text-xs font-bold text-gray-400">
                          {isEnglish ? group.labelEn : group.label}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                        {group.tags.map(({ tag, count }) => (
                          <Link
                            key={tag}
                            href={`/?tag=${encodeURIComponent(tag)}`}
                            onClick={() => setIsMobileMenuOpen(false)}
                            className={`text-xs ${group.textClass} hover:text-white transition-colors`}
                          >
                            {tag}
                            {count !== undefined ? (
                              <span className="ml-0.5 text-[9px] opacity-50">
                                {count}
                              </span>
                            ) : null}
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
