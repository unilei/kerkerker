import tagGroupsSnapshot from "@/lib/short-drama/data/duanjugou-tag-groups.json";
import { scrapeTagGroups } from "@/lib/short-drama/duanjugou";
import { appendShortDramaTagGroups } from "@/lib/short-drama-db";

/**
 * 源站标签归类映射
 *
 * duanjugou 的标签体系是「搜索词」——详情页本身没有标签字段，
 * 标签来自首页标签云（五组彩色分类：女性/男性/场景职业/爽设/单字）。
 * tag-sync 任务逐词搜索命中入库后，前台标签云需要按源站的分组结构
 * 归类渲染，因此维护 标签 → 分组 的映射。
 *
 * 三层数据源（优先级从高到低）：
 *   1. Mongo 持久化映射（runTagGroupSync 写入；源站改版后可刷新）
 *   2. 运行时抓取源站首页（scrapeTagGroups）
 *   3. 构建期快照（data/duanjugou-tag-groups.json，2026-08-31 抓取，
 *      72 标签/5 组；网络不可达时兜底）
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
 * 纯函数、无网络请求；DB 里没有映射（首次部署/未跑过同步）时
 * 直接用构建期快照，保证前台始终有完整分组。
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

export interface TagGroupSyncResult {
  categories: number;
  tags_total: number;
  source: "live" | "snapshot";
  failed: boolean;
  error?: string;
}

/**
 * 从源站抓取最新标签分组并持久化到 DB（short_drama_sync_state.tag_groups）。
 * 抓取失败时回退写构建期快照（保证 DB 里始终有可用映射），不视为致命失败。
 */
export async function runTagGroupSync(): Promise<TagGroupSyncResult> {
  let mapping: Record<string, string[]>;
  let source: "live" | "snapshot";
  try {
    const live = await scrapeTagGroups();
    mapping = {};
    for (const group of live.groups) {
      mapping[group.category] = group.tags;
    }
    source = "live";
  } catch (error) {
    mapping = { ...SNAPSHOT };
    source = "snapshot";
    await appendShortDramaTagGroups(mapping);
    return {
      categories: Object.keys(mapping).length,
      tags_total: Object.values(mapping).reduce((sum, tags) => sum + tags.length, 0),
      source,
      failed: false,
      error: `源站抓取失败，已回退构建期快照: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  await appendShortDramaTagGroups(mapping);
  return {
    categories: Object.keys(mapping).length,
    tags_total: Object.values(mapping).reduce((sum, tags) => sum + tags.length, 0),
    source,
    failed: false,
  };
}
