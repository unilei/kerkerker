/**
 * 网盘品牌（短剧站仅保留夸克——资源全部转存自夸克分享）
 */

export type PanBrand = "quark";

export const PAN_BRAND_CONFIGS: Record<
  PanBrand,
  { key: PanBrand; name: string; shortName: string; badgeClass: string; textClass: string; icon: string }
> = {
  quark: {
    key: "quark",
    name: "夸克网盘",
    shortName: "夸",
    badgeClass: "bg-orange-500",
    textClass: "text-orange-400",
    icon: "/pan-icons/quark.png",
  },
};
