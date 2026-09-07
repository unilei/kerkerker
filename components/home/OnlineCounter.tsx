"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/components/providers/locale-provider";

/**
 * 在线人数徽标：localStorage 随机访客 ID + 60s 心跳 /api/presence。
 * 首次心跳返回前不渲染（数字来自服务端，避免 SSR/CSR 水合不一致）；
 * 标签页隐藏时暂停心跳，回前台立即补一跳。
 */

const VISITOR_ID_KEY = "duanju_visitor_id";
const HEARTBEAT_MS = 60_000;

/** 取/生成随机访客 ID；localStorage 不可用（隐私模式）时退化为会话内随机 */
function getVisitorId(): string {
  const fallback = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  try {
    const existing = window.localStorage.getItem(VISITOR_ID_KEY);
    if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
    const id = fallback();
    window.localStorage.setItem(VISITOR_ID_KEY, id);
    return id;
  } catch {
    return fallback();
  }
}

export function OnlineCounter({ className = "" }: { className?: string }) {
  const [online, setOnline] = useState<number | null>(null);
  const { locale } = useLocale();
  const isEnglish = locale === "en-US";

  useEffect(() => {
    const visitorId = getVisitorId();
    let cancelled = false;

    const ping = () => {
      fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId }),
        signal: AbortSignal.timeout(10_000),
      })
        .then((response) => response.json())
        .then((payload) => {
          if (
            !cancelled &&
            payload.code === 200 &&
            Number.isInteger(payload.data?.online)
          ) {
            setOnline(payload.data.online);
          }
        })
        .catch(() => undefined);
    };

    ping();
    const timer = setInterval(() => {
      // 后台标签页不占心跳；回前台时 visibilitychange 立即补
      if (!document.hidden) ping();
    }, HEARTBEAT_MS);
    const onVisible = () => {
      if (!document.hidden) ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (online === null) return null;

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs text-gray-400 ${className}`}
      title={isEnglish ? "Visitors active in the last 5 minutes" : "近 5 分钟活跃访客"}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
      </span>
      <span className="tabular-nums">
        {isEnglish ? `${online} online` : `${online} 人在线`}
      </span>
    </span>
  );
}
