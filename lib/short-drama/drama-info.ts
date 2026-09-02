/**
 * 短剧详情信息解析（纯函数，前台详情页用）
 *
 * 数据来源优先级：
 *   1. metadata.json（转存时已解析进 drama.metadata 的结构化对象）
 *   2. 简介.txt 原文（drama.intro）——源站的行式「视频信息记录」格式：
 *        名称：X / 作者：Y / 分类：Z / 集数：N / 时长：M 分钟
 *        简介：<多段正文>
 *        演员信息：演员：A / 饰演：B / 演员简介：C
 *
 * 输出统一为可直接渲染的结构：信息位（作者/分类/时长等）、简介正文、
 * 演员列表；空字段一律不产出，避免详情页出现「演员：」空段落。
 */

export interface DramaInfoField {
  label: string;
  value: string;
}

export interface DramaInfoActor {
  name?: string;
  role?: string;
  bio?: string;
}

export interface DramaInfo {
  /** 除集数/简介外的结构化信息位（作者、分类、时长…） */
  fields: DramaInfoField[];
  /** 简介正文（不含「视频信息记录」头部与字段行） */
  description?: string;
  actors: DramaInfoActor[];
  episodeCount?: number;
}

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[\s：:_-]+/g, "")
    .replace(/（.*?）|\(.*?\)/g, "");
}

function cleanValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return text.replace(/\s+/g, " ").trim();
}

/** 「129.38分钟 秒」这类源站格式瑕疵 → 「129.38 分钟」 */
function normalizeDuration(value: string): string {
  const match = value.match(/([\d.]+)\s*分钟/);
  if (match) return `${match[1]} 分钟`;
  return value.replace(/\s*秒$/, "");
}

function asNumber(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(cleanValue(value));
  return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}

/** 在 metadata 对象里按候选键宽容取值（键名归一化后匹配） */
function pickValue(
  source: Record<string, unknown>,
  candidates: string[]
): unknown {
  for (const [key, value] of Object.entries(source)) {
    const normalized = normalizeKey(key);
    if (candidates.includes(normalized) && cleanValue(value) !== "") {
      return value;
    }
  }
  return undefined;
}

function parseActorsValue(value: unknown): DramaInfoActor[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return { name: cleanValue(item) };
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const name =
            cleanValue(record.name) ||
            cleanValue(record["演员"]) ||
            cleanValue(record.actor) ||
            "";
          const role =
            cleanValue(record.role) ||
            cleanValue(record["饰演"]) ||
            cleanValue(record.character) ||
            "";
          const bio =
            cleanValue(record.bio) ||
            cleanValue(record["演员简介"]) ||
            cleanValue(record.intro) ||
            "";
          return { name, role, bio };
        }
        return { name: "" };
      })
      .filter((actor) => actor.name || actor.role || actor.bio);
  }
  return [];
}

/** 解析简介.txt 的行式结构（metadata 缺失时兜底） */
function parseIntroText(intro: string): {
  fields: DramaInfoField[];
  description?: string;
  actors: DramaInfoActor[];
  episodeCount?: number;
} {
  const lines = intro.replace(/\r\n/g, "\n").split("\n");
  const labeled: Record<string, string> = {};
  const descriptionLines: string[] = [];
  const actorBlock: string[] = [];
  let section: "head" | "description" | "actors" = "head";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^演员信息/.test(line)) {
      section = "actors";
      continue;
    }
    if (/^简介[:：]?\s*$/.test(line)) {
      section = "description";
      continue;
    }
    const labeledMatch = line.match(/^([\u4e00-\u9fa5A-Za-z]{1,8})[:：]\s*(.*)$/);
    if (section === "actors") {
      actorBlock.push(line);
      continue;
    }
    if (section === "head") {
      if (labeledMatch) {
        labeled[normalizeKey(labeledMatch[1])] = cleanValue(labeledMatch[2]);
        continue;
      }
      if (!line) continue;
      // 无标记行：短头部说明（如「视频信息记录」）跳过，
      // 长段落视为没有字段头的纯简介正文开始
      if (line.length > 15) section = "description";
      else continue;
    }
    if (section === "description" && labeledMatch && !labeledMatch[2]) {
      // 简介段尾部出现的空字段行（如「备注：」），跳过
      continue;
    }
    if (line) {
      descriptionLines.push(rawLine.trimEnd());
    } else if (descriptionLines.length > 0) {
      descriptionLines.push("");
    }
  }

  const fields: DramaInfoField[] = [];
  const author = labeled["作者"] || labeled["出品方"] || "";
  if (author) fields.push({ label: "作者", value: author });
  const category = labeled["分类"] || labeled["类型"] || "";
  if (category) fields.push({ label: "分类", value: category });
  if (labeled["时长"]) {
    fields.push({ label: "时长", value: normalizeDuration(labeled["时长"]) });
  }

  const cast = parseActorBlock(actorBlock);
  return {
    fields,
    description:
      descriptionLines.join("\n").replace(/\n{3,}/g, "\n\n").trim() || undefined,
    actors: cast,
    episodeCount: asNumber(labeled["集数"]),
  };
}

/** 演员信息块：按「演员：/饰演：/演员简介：」三元组配对 */
function parseActorBlock(block: string[]): DramaInfoActor[] {
  const actors: DramaInfoActor[] = [];
  let current: DramaInfoActor = {};
  for (const line of block) {
    const match = line.match(/^(演员|饰演|演员简介)[:：]\s*(.*)$/);
    if (match) {
      const key = match[1];
      const value = cleanValue(match[2]);
      if (key === "演员") {
        if (current.name || current.role || current.bio) {
          actors.push(current);
        }
        current = value ? { name: value } : {};
      } else if (key === "饰演" && value) {
        current.role = value;
      } else if (key === "演员简介" && value) {
        current.bio = value;
      }
    } else if (line && (current.name || current.role)) {
      // 无标签的续行，并入上一个字段
      current.bio = current.bio ? `${current.bio} ${line}` : line;
    }
  }
  if (current.name || current.role || current.bio) actors.push(current);
  return actors.filter((actor) => actor.name || actor.role || actor.bio);
}

const FIELD_KEYS = {
  author: ["作者", "出品方", "制作方", "author", "studio", "production"],
  category: ["分类", "类型", "题材", "genre", "category"],
  duration: ["时长", "片长", "duration", "runtime"],
  episodes: ["集数", "总集数", "episodecount", "totalepisodes", "episodes"],
  description: ["简介", "剧情简介", "内容介绍", "description", "synopsis", "intro", "content"],
  actors: ["演员", "演员表", "演员信息", "主演", "actors", "cast"],
};

/** 主入口：metadata.json 优先，缺失的字段用简介.txt 解析兜底 */
export function parseDramaInfo(
  metadata?: Record<string, unknown> | null,
  intro?: string | null
): DramaInfo {
  const result: DramaInfo = { fields: [], actors: [] };

  const introParsed = intro ? parseIntroText(intro) : null;

  if (metadata && Object.keys(metadata).length > 0) {
    const author = cleanValue(pickValue(metadata, FIELD_KEYS.author));
    const category = cleanValue(pickValue(metadata, FIELD_KEYS.category));
    const durationRaw = cleanValue(pickValue(metadata, FIELD_KEYS.duration));
    const description = cleanValue(pickValue(metadata, FIELD_KEYS.description));
    const episodeCount = asNumber(pickValue(metadata, FIELD_KEYS.episodes));
    const actors = parseActorsValue(pickValue(metadata, FIELD_KEYS.actors));

    if (author) result.fields.push({ label: "作者", value: author });
    if (category) result.fields.push({ label: "分类", value: category });
    if (durationRaw) {
      result.fields.push({ label: "时长", value: normalizeDuration(durationRaw) });
    }
    if (episodeCount) result.episodeCount = episodeCount;
    if (description) result.description = description;
    result.actors = actors;
  } else if (introParsed) {
    result.fields = introParsed.fields;
    result.description = introParsed.description;
    result.actors = introParsed.actors;
    if (introParsed.episodeCount) result.episodeCount = introParsed.episodeCount;
  }

  // metadata 缺个别字段时用简介文本补齐（都解析出来后合并）
  if (introParsed) {
    if (result.fields.length === 0 && introParsed.fields.length > 0) {
      result.fields = introParsed.fields;
    }
    if (!result.description && introParsed.description) {
      result.description = introParsed.description;
    }
    if (result.actors.length === 0 && introParsed.actors.length > 0) {
      result.actors = introParsed.actors;
    }
  }

  return result;
}
