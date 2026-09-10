import {
  fetchQuarkDownloadUrlForFile,
  QuarkApiClient,
  QuarkCredentialInvalidError,
} from "@/lib/quark/quark-api-client";
import {
  refreshQuarkCredentialPuus,
  markCloudCredentialInvalid,
} from "@/lib/cloud-credentials-db";
import { uploadCoverToR2, fetchSignedDownloadBytes } from "@/lib/short-drama/cover-mirror";
import {
  takeShortDramasForMetadataSync,
  patchShortDramaMetadata,
  updateShortDramaSyncState,
  tryAcquireShortDramaSyncLease,
  releaseShortDramaSyncLease,
  consumeShortDramaSyncCancel,
  updateShortDramaSyncLeaseProgress,
} from "@/lib/short-drama-db";
import type { ShortDrama, ShortDramaMetadataPiece } from "@/types/short-drama";
import { withWatchdog } from "@/lib/short-drama/watchdog";

/**
 * 元数据同步：对已发布且有 kkpan 分享链接的短剧，列 kkpan 的分享目录
 * （分享树）、下载封面/简介/metadata 三件套（封面 R2 镜像），回填本地库。
 * 不做转存、不建分享——条目与链接都来自 kkpan。
 *
 * 每条流程：inspectShareTree 列分享目录（三件套按类型识别，排在剧集
 * 视频列表最底部）→ 下载：
 *   - 图片：签名直链下载 → R2 镜像（未配置 R2 时跳过，封面留空）
 *   - JSON：下载并 JSON 解析（坏 JSON 原文丢弃）
 *   - 文本：下载按 UTF-8 解码
 * 下载用 kkpan 同账号的凭证 cookie（分享树里的 fid 即 kkpan 网盘内
 * 文件的真实 fid）。目录里确认源目录本就没有的部件写入 missing_at_source
 * 终结标记并豁免出队（转存目录是静态副本，重试无果）。
 */

const SYNC_LEASE_TTL_MS = 60 * 60 * 1_000;
const SAVE_DELAY_MS = 3_000;
const PROGRESS_EXTEND_TTL_MS = 60 * 60 * 1_000;
// 进度写库节流：单条要数十秒，页面 3s 轮询下每次事件都写也够低频
const PROGRESS_WRITE_INTERVAL_MS = 3_000;

let lastProgressWriteAt = 0;
async function reportMetadataSyncProgress(
  stage: string,
  message: string,
  done?: number,
  total?: number
): Promise<void> {
  const now = Date.now();
  if (now - lastProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
  lastProgressWriteAt = now;
  await updateShortDramaSyncLeaseProgress(
    { stage, message, done, total },
    { extendTtlMs: PROGRESS_EXTEND_TTL_MS }
  );
}

export interface MetadataSyncStats {
  attempted: number;
  covers_mirrored: number;
  intros_set: number;
  metadata_set: number;
  /** 三件套全部补齐的条目数（本轮后已完整） */
  resolved: number;
  /** 仍有「可重试缺失」的条目数（下载失败/索引延迟等，留在队列下轮再试） */
  still_missing: number;
  /** 缺失部件全部核实为「源目录里本就没有」的条目数（已写
   *  missing_at_source 终结标记并出队，与 still_missing 互斥） */
  source_missing: number;
  credentials_invalid: boolean;
  stopped_reason:
    | "completed"
    | "budget"
    | "cancelled"
    | "nothing_to_do"
    | "credential_invalid"
    | "lease_busy";
  failed_fatal: boolean;
  error?: string;
}

export interface MetadataSyncOptions {
  /** 单轮最多处理几条（0/缺省 = 处理完整个队列；全量请走 background） */
  maxItems?: number;
}

export async function runShortDramaMetadataSync(
  options: MetadataSyncOptions = {}
): Promise<MetadataSyncStats> {
  const stats: MetadataSyncStats = {
    attempted: 0,
    covers_mirrored: 0,
    intros_set: 0,
    metadata_set: 0,
    resolved: 0,
    still_missing: 0,
    source_missing: 0,
    credentials_invalid: false,
    stopped_reason: "completed",
    failed_fatal: false,
  };
  const maxItems = options.maxItems && options.maxItems > 0 ? options.maxItems : Infinity;

  if (!(await tryAcquireShortDramaSyncLease(SYNC_LEASE_TTL_MS))) {
    stats.stopped_reason = "lease_busy";
    stats.failed_fatal = true;
    stats.error = "已有元数据同步任务在运行";
    return stats;
  }

  try {
    // 封面/简介/metadata 全靠 CDN 下载，__puus（CDN 下载签名）寿命只有
    // 1-2 天，开工前先续期（6 小时内跑过的任务直接沿用）
    const cookie = await refreshQuarkCredentialPuus();
    if (!cookie) {
      stats.stopped_reason = "credential_invalid";
      stats.failed_fatal = true;
      stats.error = "未配置夸克凭证，请先在后台粘贴 kkpan 同账号的 cookie";
      return stats;
    }

    const queue = await takeShortDramasForMetadataSync(
      Number.isFinite(maxItems) ? maxItems : 50_000
    );
    if (queue.length === 0) {
      stats.stopped_reason = "nothing_to_do";
      return stats;
    }

    // 新一轮任务强制写第一条进度（清掉上一轮遗留的节流时间戳）
    lastProgressWriteAt = 0;
    // 清掉可能残留的取消标记（上轮取消未被循环消费时，不能让新任务秒停）
    await consumeShortDramaSyncCancel();
    const plannedTotal = Math.min(queue.length, maxItems);
    for (const [queueIndex, drama] of queue.entries()) {
      // 取消检查点：当前这部剧跑完、不再取下一条
      if (await consumeShortDramaSyncCancel()) {
        stats.stopped_reason = "cancelled";
        reportMetadataSyncProgress("metadata_sync", "已取消：停止补齐", queueIndex, plannedTotal);
        break;
      }
      if (stats.attempted >= maxItems) {
        stats.stopped_reason = "budget";
        break;
      }
      stats.attempted += 1;
      reportMetadataSyncProgress(
        "metadata_sync",
        `补齐元数据（${queueIndex + 1}/${plannedTotal}）：${
          drama.title
        }${drama.episode_count ? `（${drama.episode_count}集）` : ""}`,
        queueIndex + 1,
        plannedTotal
      );
      try {
        const meta = await withWatchdog(
          collectMetadata(cookie, drama.share_url, drama)
        );
        if (meta.coverUrl) {
          stats.covers_mirrored += 1;
        }
        if (meta.intro) stats.intros_set += 1;
        if (meta.metadata) stats.metadata_set += 1;
        // 按部件分类缺失去向：本轮列目录确认源里没有的（sourceMissing）
        // 会被标记终结；仅剩源缺失的条目出队，仍有可重试缺失的留在队列
        const sourceMissing = meta.sourceMissing ?? [];
        const anyMissing = !meta.coverUrl || !meta.intro || !meta.metadata;
        const retriableMissing =
          (!meta.coverUrl && !sourceMissing.includes("cover")) ||
          (!meta.intro && !sourceMissing.includes("intro")) ||
          (!meta.metadata && !sourceMissing.includes("metadata"));
        if (!anyMissing) {
          stats.resolved += 1;
        } else if (!retriableMissing) {
          stats.source_missing += 1;
        } else {
          stats.still_missing += 1;
        }
        await patchShortDramaMetadata(drama.id, {
          ...(meta.coverUrl ? { cover_url: meta.coverUrl } : {}),
          ...(meta.intro ? { intro: meta.intro } : {}),
          ...(meta.metadata ? { metadata: meta.metadata } : {}),
          // 整组覆盖（空数组=清除旧标记）：以本轮列目录的核实结果为准，
          // 部件一旦找到即移出终结标记，不会误标后永久出队
          missing_at_source: sourceMissing,
        });
      } catch (error) {
        if (error instanceof QuarkCredentialInvalidError) {
          stats.credentials_invalid = true;
          stats.stopped_reason = "credential_invalid";
          stats.failed_fatal = true;
          stats.error = error.message;
          await markCloudCredentialInvalid("quark");
          break;
        }
        console.warn(
          `短剧元数据同步失败 id=${drama.id}:`,
          error instanceof Error ? error.message : String(error)
        );
        stats.still_missing += 1;
        // 看门狗超时留给下轮重试（底层操作无法取消，放弃等待即可）
      }
      await sleep(SAVE_DELAY_MS);
    }

    await updateShortDramaSyncState({
      last_metadata_sync_at: new Date().toISOString(),
      last_metadata_sync_stats: stats as unknown as Record<string, unknown>,
    });
    return stats;
  } catch (error) {
    stats.failed_fatal = true;
    stats.error = error instanceof Error ? error.message : String(error);
    return stats;
  } finally {
    await releaseShortDramaSyncLease();
  }
}

interface CollectedMetadata {
  coverMirrored: boolean;
  coverUrl?: string;
  intro?: string;
  metadata?: Record<string, unknown>;
  /**
   * 本轮列目录对「kkpan 转存目录里是否存在该类型文件」的核实结果
   * （恒为数组，空数组=全部存在或目录列表不可信）。仅当目录里能看到
   * 剧集视频文件（列目录确有其物、不是空/截断响应）才报告缺失；
   * 下载失败/解析失败不算缺失（可重试）。调用方整组覆盖写库，
   * 部件找到即移出旧标记。
   */
  sourceMissing: ShortDramaMetadataPiece[];
}

// ---------------------------------------------------------------------------
// 元数据三件套识别：按文件大类找（kkpan 转存来源多、命名五花八门——
// 实测同一分享夹里文本有 简介.txt/详细简介.txt/视频信息.txt，图片有
// 封面.jpg/0.jpg/海报.jpg/剧名.jpg），扩展名放宽 + 大类内部按优先级
// 挑选。以下 pick 系列均为纯函数，供单测。
// ---------------------------------------------------------------------------

// 图片：常见位图全收（含 jfif/heic 等手机/截图形态）
const IMAGE_FILE_PATTERN = /\.(jpe?g|png|webp|gif|avif|bmp|jfif|tiff?|heic|heif)$/i;
// 文本：文本类简介/信息文件；刻意排除 srt/ass 等字幕（不是简介）
const TEXT_FILE_PATTERN = /\.(txt|md|nfo|log|text)$/i;
const JSON_FILE_PATTERN = /\.jsonc?$/i;
// 剧集视频文件：源缺失核实的「目录确有其物」证据（无视频时列目录结果
// 不可信——可能整目录被过滤/空目录，不能据此判定三件套缺失）
const VIDEO_FILE_PATTERN = /\.(mp4|mkv|ts|flv|mov|m4v)$/i;

/** 封面挑选：关键词命名（封面/海报等）> 剧名同名图 > 体积最大（海报通常
 *  比缩略图/截图大）> 原始顺序。绝不因为命名不固定而放弃图片类。 */
export function pickCoverFile<T extends { name: string; size?: number | null }>(
  images: T[],
  dramaTitle?: string
): T | undefined {
  if (images.length === 0) return undefined;
  const keyword = images.find((item) => /封面|海报|cover|poster/i.test(item.name));
  if (keyword) return keyword;
  if (dramaTitle) {
    const baseTitle = dramaTitle.replace(/\s+/g, "").slice(0, 12);
    const byTitle =
      baseTitle.length >= 4 &&
      images.find((item) => item.name.replace(/\.[^.]+$/, "").replace(/\s+/g, "").includes(baseTitle));
    if (byTitle) return byTitle;
  }
  return [...images].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0] ?? images[0];
}

/** 简介挑选：简介/剧情类命名优先，「详细简介」优于「简介」，技术参数类
 *  （视频信息等）垫底；同级取体积最大（更长更完整）。 */
export function pickIntroFile<T extends { name: string; size?: number | null }>(
  texts: T[]
): T | undefined {
  if (texts.length === 0) return undefined;
  const score = (name: string): number => {
    const lower = name.toLowerCase();
    if (/详细简介|详细介绍|详细剧情/.test(lower)) return 3;
    if (/简介|intro|synopsis|剧情|故事梗概/.test(lower)) return 2;
    if (/视频信息|参数|规格|技术/.test(lower)) return 0;
    return 1;
  };
  return [...texts].sort(
    (a, b) => score(b.name) - score(a.name) || (b.size ?? 0) - (a.size ?? 0)
  )[0];
}

/** metadata JSON 挑选：精确 metadata.json 优先，其次任意 json（同为 json
 *  时取体积最大，内容更可能完整）。 */
export function pickMetadataFile<T extends { name: string; size?: number | null }>(
  jsons: T[]
): T | undefined {
  if (jsons.length === 0) return undefined;
  const exact = jsons.find((item) => item.name.toLowerCase() === "metadata.json");
  if (exact) return exact;
  return [...jsons].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0] ?? jsons[0];
}

/**
 * 列 kkpan 分享树并抓取三件套（封面→R2 镜像、简介、metadata JSON）。
 * 分享树里的 fid 即 kkpan 网盘内文件的真实 fid，用 kkpan 同账号凭证
 * 的 file/download 直链下载。
 */
export async function collectMetadata(
  cookie: string,
  shareUrl: string,
  drama: ShortDrama
): Promise<CollectedMetadata> {
  const result: CollectedMetadata = { coverMirrored: false, sourceMissing: [] };

  const client = new QuarkApiClient({ cookie });
  const items = await client.inspectShareTree(shareUrl);
  const files = items.filter((item) => !item.dir);
  const imageFiles = files.filter((item) => IMAGE_FILE_PATTERN.test(item.name));
  const textFiles = files.filter((item) => TEXT_FILE_PATTERN.test(item.name));
  const jsonFiles = files.filter((item) => JSON_FILE_PATTERN.test(item.name));
  if (imageFiles.length === 0 && textFiles.length === 0 && jsonFiles.length === 0) {
    console.warn(
      `短剧元数据 id=${drama.id}: 转存目录 ${items.length} 项未见图片/文本/JSON 元数据文件（可能仍在校验/过滤中）`
    );
  }
  // 源缺失核实：目录里能看到剧集视频（说明列目录确有其物、不是空响应），
  // 却没有任何对应类型文件 → 该部件在源目录里就不存在，重试无意义
  const sourceMissing: ShortDramaMetadataPiece[] = [];
  if (files.some((item) => VIDEO_FILE_PATTERN.test(item.name))) {
    if (imageFiles.length === 0) sourceMissing.push("cover");
    if (textFiles.length === 0) sourceMissing.push("intro");
    if (jsonFiles.length === 0) sourceMissing.push("metadata");
  }
  const cover = pickCoverFile(imageFiles, drama.title);
  const metadataFile = pickMetadataFile(jsonFiles);
  const introFile = pickIntroFile(textFiles);

  if (cover) {
    const download = await fetchQuarkDownloadUrlForFile(cookie, cover.fid);
    const bytes = await fetchSignedDownloadBytes(download.downloadUrl, undefined, cookie);
    if (bytes) {
      const ext = extensionForContentType(bytes.contentType, cover.name);
      const coverUrl = await uploadCoverToR2({
        // coverObjectKey 会再拼顶层前缀（CLOUDFLARE_R2_COVER_KEY_PREFIX 或
        // 缺省 short-drama-covers），这里只传文件键
        key: `${drama.source_article_id}.${ext}`,
        body: bytes.body,
        contentType: bytes.contentType,
      });
      if (coverUrl) {
        result.coverUrl = coverUrl;
        result.coverMirrored = true;
      } else {
        console.warn(
          `短剧元数据 id=${drama.id}: 封面下载成功但 R2 上传未返回 URL（检查 R2 配置）`
        );
      }
    } else {
      // 最常见原因：__puus 过期被 CDN 412（任务启动时已自动续期，
      // 仍失败多为 CDN 风控或直链签名异常）
      console.warn(
        `短剧元数据 id=${drama.id}: 封面「${cover.name}」下载失败（CDN 412/风控？）`
      );
    }
  }

  if (metadataFile) {
    const download = await fetchQuarkDownloadUrlForFile(cookie, metadataFile.fid);
    const bytes = await fetchSignedDownloadBytes(
      download.downloadUrl,
      1024 * 1024,
      cookie
    );
    if (bytes) {
      try {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.body);
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          result.metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // 坏 JSON：保留链接不解析
      }
    }
  }

  if (introFile) {
    const download = await fetchQuarkDownloadUrlForFile(cookie, introFile.fid);
    const bytes = await fetchSignedDownloadBytes(download.downloadUrl, 1024 * 1024, cookie);
    if (bytes) {
      result.intro = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes.body)
        .trim()
        .slice(0, 20_000);
    }
  }

  // 恒返回数组（空数组=清除旧标记），调用方整组覆盖写库
  result.sourceMissing = sourceMissing;
  return result;
}

function extensionForContentType(contentType: string, fileName: string): string {
  const mapping: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };
  if (mapping[contentType]) return mapping[contentType];
  const dot = fileName.lastIndexOf(".");
  if (dot >= 0) return fileName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  return "jpg";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
