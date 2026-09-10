import tagGroupsSnapshot from "@/lib/short-drama/data/duanjugou-tag-groups.json";

/**
 * 源站标签归类映射（历史 duanjugou 数据，前台标签菜单仍按此分组渲染）
 *
 * duanjugou 的标签体系是「搜索词」——标签来自其首页标签云（五组彩色
 * 分类：女性/男性/场景职业/爽设/单字）。抓取流水线已废弃，kkpan 没有
 * 标签体系；本映射只剩两层数据源（优先级从高到低）：
 *   1. Mongo 持久化映射（short_drama_sync_state.tag_groups，历史数据）
 *   2. 构建期快照（data/duanjugou-tag-groups.json，2026-08-31 抓取，
 *      72 标签/5 组）
 * 新条目无标签（恒空数组），标签云/落地页自然为空，UI 结构暂时保留。
 */

export interface DramaTagGroup {
  category: string;
  tags: string[];
}

export interface DramaTagAssignment {
  category: string;
  tag: string;
}

const SNAPSHOT = tagGroupsSnapshot as Record<string, string[]>;

function groupsFromMapping(mapping: Record<string, string[]>): DramaTagGroup[] {
  const order = ["女性标签", "男性标签", "场景职业", "爽设标签", "单字标签"];
  const seenCategories = new Set<string>();
  const groups: DramaTagGroup[] = [];

  const push = (category: string, tags: string[]) => {
    if (!category || tags.length === 0) return;
    seenCategories.add(category);
    groups.push({ category, tags });
  };

  // 先按源站固定组序输出
  for (const category of order) {
    if (mapping[category]) push(category, mapping[category]);
  }
  // 兼容源站未来新增的分组（保持映射里的出现顺序）
  for (const [category, tags] of Object.entries(mapping)) {
    if (!seenCategories.has(category)) push(category, tags);
  }
  return groups;
}

/** 把「组 → 标签[]」拍平成「标签 → 组」（同标签多组时先出现者优先） */
export function flattenTagGroups(
  groups: DramaTagGroup[]
): Map<string, string> {
  const tagToCategory = new Map<string, string>();
  for (const group of groups) {
    for (const tag of group.tags) {
      if (!tagToCategory.has(tag)) tagToCategory.set(tag, group.category);
    }
  }
  return tagToCategory;
}

/**
 * 解析归类映射：优先用持久化快照（DB），缺组时回退构建期快照。
 * 纯函数、无网络请求；DB 里没有映射（首次部署/历史数据为空）时
 * 直接用构建期快照，保证前台始终有完整分组。live 参数保留兼容
 * （调用方传 null）。
 */
export function mergeTagGroupSources(
  stored: Record<string, string[]> | null,
  live: Record<string, string[]> | null
): DramaTagGroup[] {
  // live（本次同步抓到的新版）整体覆盖 stored；再对缺失组用快照兜底
  const merged: Record<string, string[]> = {};
  for (const source of [SNAPSHOT, stored, live]) {
    if (!source) continue;
    for (const [category, tags] of Object.entries(source)) {
      if (Array.isArray(tags) && tags.length > 0) merged[category] = tags;
    }
  }
  return groupsFromMapping(merged);
}
