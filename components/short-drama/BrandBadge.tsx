"use client";

import { useState } from "react";
import { PAN_BRAND_CONFIGS, type PanBrand } from "@/types/pan-brand";

type BadgeSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: "w-6 h-6",
  md: "w-8 h-8",
  lg: "w-9 h-9",
};

const LETTER_CLASSES: Record<BadgeSize, string> = {
  sm: "text-[9px]",
  md: "text-[11px]",
  lg: "text-xs",
};

interface BrandBadgeProps {
  brand: PanBrand;
  size?: BadgeSize;
}

/**
 * 网盘品牌徽标：白色圆底 + 官方 logo（自托管 public/pan-icons/），
 * logo 加载失败时退回品牌色字标，不留空。
 */
export function BrandBadge({ brand, size = "lg" }: BrandBadgeProps) {
  const [failed, setFailed] = useState(false);
  const config = PAN_BRAND_CONFIGS[brand];

  return (
    <span
      className={`${SIZE_CLASSES[size]} rounded-full bg-white flex items-center justify-center shrink-0 shadow-sm overflow-hidden ring-1 ring-black/10`}
    >
      {config.icon && !failed ? (
        <img
          src={config.icon}
          alt={config.name}
          className="w-[62%] h-[62%] object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className={`${config.badgeClass} w-full h-full flex items-center justify-center text-white font-bold ${LETTER_CLASSES[size]}`}
        >
          {config.shortName}
        </span>
      )}
    </span>
  );
}
