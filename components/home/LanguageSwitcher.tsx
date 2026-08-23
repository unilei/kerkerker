"use client";

import { Languages } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/components/providers/locale-provider";
import type { SupportedLocale } from "@/lib/locale";

const OPTIONS: readonly { value: SupportedLocale; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "EN" },
];

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { locale, setLocale } = useLocale();

  const handleChange = (nextLocale: SupportedLocale) => {
    if (nextLocale === locale) return;
    setLocale(nextLocale);
    router.refresh();
  };

  return (
    <div
      className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1"
      role="group"
      aria-label="Language"
    >
      <Languages className="ml-1.5 h-4 w-4 text-gray-400" aria-hidden="true" />
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => handleChange(option.value)}
          aria-pressed={locale === option.value}
          aria-label={option.value === "zh-CN" ? "中文" : "English"}
          className={`min-w-9 rounded-full px-2 py-1 text-xs font-semibold transition-colors ${
            locale === option.value
              ? "bg-white text-black"
              : "text-gray-400 hover:bg-white/10 hover:text-white"
          }`}
        >
          {compact ? option.label : option.value === "zh-CN" ? "中文" : "EN"}
        </button>
      ))}
    </div>
  );
}
