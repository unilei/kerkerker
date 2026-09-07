"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useScrollState } from "@/hooks/useScrollState";
import { Navbar } from "@/components/home/Navbar";
import { Footer } from "@/components/home/Footer";
import { SearchModal } from "@/components/short-drama/SearchModal";

/**
 * 服务端页面的通用壳：导航栏 + 搜索弹层（交互态），children 仍由
 * 服务端组件直出（SEO 首屏内容不进客户端）。标签目录/落地页共用。
 */
export function PageShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const scrolled = useScrollState(50);
  const [showSearch, setShowSearch] = useState(false);

  return (
    <div className="min-h-screen bg-black">
      <Navbar scrolled={scrolled} onSearchOpen={() => setShowSearch(true)} />
      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          onSearch={(keyword) => {
            setShowSearch(false);
            router.push(`/?search=${encodeURIComponent(keyword)}`);
          }}
        />
      )}
      {children}
      <Footer />
    </div>
  );
}
