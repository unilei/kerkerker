"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { Menu, X, Home, Film, Tv, Clock, Video, Github } from "lucide-react";

interface NavbarProps {
  scrolled: boolean;
  onSearchOpen: () => void;
}

export function Navbar({ scrolled, onSearchOpen }: NavbarProps) {
  const router = useRouter();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // 防止移动端菜单打开时页面滚动
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isMobileMenuOpen]);

  const navItems = [
    { href: "/", label: "首页", icon: Home },
    { href: "/browse/movies", label: "电影", icon: Film },
    { href: "/browse/tv", label: "电视剧", icon: Tv },
    { href: "/browse/latest", label: "最新", icon: Clock },
    { href: "/dailymotion", label: "短剧Motion", icon: Video },
    { href: "https://github.com/unilei/kerkerker", label: "Github", icon: Github, external: true },
  ];

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
            <div className="flex items-center gap-1">
              <img className="w-8 h-8 md:w-10 md:h-10" src="/logo.png" alt="logo" />
              <h1
                onClick={() => {
                  router.push("/");
                  setIsMobileMenuOpen(false);
                }}
                className="text-red-600 text-xl md:text-2xl lg:text-3xl font-bold tracking-tight cursor-pointer hover:text-red-500 transition-colors"
              >
                壳儿
              </h1>
            </div>

            {/* 导航链接 - 桌面端 */}
            <div className="hidden md:flex items-center space-x-6">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  target={item.external ? "_blank" : undefined}
                  className="text-gray-400 hover:text-white transition-colors text-sm font-medium"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>

          {/* 右侧功能区 */}
          <div className="flex items-center space-x-2 md:space-x-4">
            {/* 搜索按钮 */}
            <button
              onClick={onSearchOpen}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
              aria-label="搜索"
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
          </div>
        </div>
      </nav>

      {/* 移动端侧边栏菜单 */}
      <div
        className={`md:hidden fixed inset-0 z-40 transition-opacity duration-300 ${
          isMobileMenuOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
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
                壳儿
              </h2>
            </div>
          </div>

          {/* 导航菜单 */}
          <nav className="p-4 space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  target={item.external ? "_blank" : undefined}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="flex items-center space-x-3 px-4 py-3 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-all duration-200 group"
                >
                  <Icon className="w-5 h-5 text-gray-400 group-hover:text-red-500 transition-colors" />
                  <span className="text-base font-medium">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {/* 侧边栏底部 */}
          <div className="absolute bottom-0 left-0 right-0 p-6 border-t border-gray-800">
            <p className="text-xs text-gray-500 text-center">
              © 2025 壳儿 · 这就是个壳儿
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
