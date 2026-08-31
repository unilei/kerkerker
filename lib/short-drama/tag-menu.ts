/**
 * 导航栏「分类」菜单数据
 *
 * 结构 = 一级热门题材直链 + 二级下拉分组：
 * - 直链：跨组挑选的热门题材词，点进去即 /?tag= 筛选；
 * - 下拉：源站五组分类映射成用户语感的四个菜单组
 *   （女性标签→女频、男性标签→男频、场景职业→题材、爽设标签→爽点）；
 *   「单字标签」是源站搜索词特性、非用户浏览心智，不进菜单（词仍可筛选）。
 *
 * 菜单需要稳定、零请求的渲染，因此内置构建期快照
 * （lib/short-drama/data/duanjugou-tag-groups.json，2026-08-31 抓取，72 词/5 组）；
 * 挂载后由 Navbar 用 /api/short-dramas/tags 水合（库内分组与命中计数）。
 */

export interface TagQuickLink {
  /** 筛选词（对应源站搜索词） */
  tag: string;
  label: string;
  labelEn: string;
}

export interface TagMenuGroup {
  /** 菜单展示名（用户语感） */
  label: string;
  labelEn: string;
  /** 源站分类名（对应 /api/short-dramas/tags 返回的 category，用于水合对位） */
  sourceCategory: string;
  tags: string[];
  /** 组主题点色（Tailwind bg-*） */
  dotClass: string;
  /** 组内标签文字色（Tailwind text-*） */
  textClass: string;
}

/** 一级导航热门题材直链 */
export const TAG_QUICK_LINKS: TagQuickLink[] = [
  { tag: "总裁", label: "总裁", labelEn: "CEO" },
  { tag: "战神", label: "战神", labelEn: "War God" },
  { tag: "赘婿", label: "赘婿", labelEn: "Son-in-law" },
  { tag: "穿越", label: "穿越", labelEn: "Transmigration" },
];

export const TAG_MENU_GROUPS: TagMenuGroup[] = [
  {
    label: "女频",
    labelEn: "For Her",
    sourceCategory: "女性标签",
    tags: [
      "娇妻", "阿姨", "夫人", "女友", "老婆", "前妻", "千金", "公主",
      "宠妻", "女王", "女神", "甜妻", "萌宝", "妈咪", "女儿", "婆婆",
      "小姐", "美女", "秘书",
    ],
    dotClass: "bg-red-500",
    textClass: "text-red-300",
  },
  {
    label: "男频",
    labelEn: "For Him",
    sourceCategory: "男性标签",
    tags: [
      "少爷", "王爷", "男友", "狂少", "老公", "前夫", "龙帅", "赘婿",
      "爸爸", "爹地", "老爸", "陛下", "儿子", "顾少",
    ],
    dotClass: "bg-sky-500",
    textClass: "text-sky-300",
  },
  {
    label: "题材",
    labelEn: "Themes",
    sourceCategory: "场景职业",
    tags: [
      "都市", "穿越", "归来", "马甲", "逆袭", "离婚", "职场", "闪婚",
      "爱恨", "老师", "保安", "外卖", "快递", "保镖", "顾总",
    ],
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-300",
  },
  {
    label: "爽点",
    labelEn: "Tropes",
    sourceCategory: "爽设标签",
    tags: [
      "神医", "总裁", "隐龙", "绝世", "战神", "至尊", "首富", "亿万",
      "大佬", "神豪", "天尊", "遮天", "武神",
    ],
    dotClass: "bg-orange-500",
    textClass: "text-orange-300",
  },
];

/**
 * 源站全部分类名（含刻意不进菜单的「单字标签」）。
 * 水合时库内出现这些之外的分类（如「其他标签」或源站新增组）才尾随展示，
 * 已知但隐藏的组（单字标签）不渲染。
 */
export const KNOWN_SOURCE_CATEGORIES = [
  ...TAG_MENU_GROUPS.map((group) => group.sourceCategory),
  "单字标签",
];
