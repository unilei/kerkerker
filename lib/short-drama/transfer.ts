import { QuarkApiClient } from "@/lib/quark/quark-api-client";
import {
  fetchQuarkDownloadUrlForFile,
  listQuarkOwnDirectory,
  QuarkCredentialInvalidError,
} from "@/lib/quark/quark-api-client";
import {
  getCloudCredentialCookie,
  markCloudCredentialInvalid,
} from "@/lib/cloud-credentials-db";
import { uploadCoverToR2, fetchSignedDownloadBytes } from "@/lib/short-drama/cover-mirror";
import {
  takeShortDramasForTransfer,
  takeShortDramasForMetadataBackfill,
  patchShortDramaTransfer,
  updateShortDramaSyncState,
  tryAcquireShortDramaLease,
  releaseShortDramaLease,
  getShortDramaSyncState,
} from "@/lib/short-drama-db";
import type { ShortDrama } from "@/types/short-drama";

/**
 * 短剧转存流水线
 *
 * 每部短剧：
 *   1. 用已移植的 QuarkApiClient.transferAndShare 把源站夸克分享
 *      整体转存到自己网盘并生成自己的分享链接（kkpan 同款流程，串行防风控）。
 *   2. 定位转存出的剧名目录（save 返回的 savedFids 即目录 fid）。
 *   3. 列目录找 封面.jpg / metadata.json / 简介.txt：
 *      - 封面：签名直链下载 → R2 镜像（未配置 R2 时跳过，封面留空）
 *      - metadata.json：下载并 JSON 解析（坏 JSON 原文丢弃）
 *      - 简介.txt：下载按 UTF-8 解码
 *   4. 状态机回写 done / failed；凭证失效时标记凭证并整轮中止。
 *
 * transferAndShare 的保存边界策略会把"剧名目录"整体作为 save 单元，
 * savedFids[0] 即自己网盘中的目录 fid，可直接 file/sort 列内部文件。
 */

const TRANSFER_LEASE_TTL_MS = 60 * 60 * 1_000;
const SAVE_DELAY_MS = 3_000;
const MAX_ATTEMPTS = 3;
const TRANSFER_DELAY_SAFETY_MS = 10 * 60 * 1_000;
// 夸克 save 异步落库的索引等待：每 3s 重列一次目录，最多 5 次（约 15s）
const METADATA_LIST_STABILIZE_POLLS = 5;
const METADATA_LIST_STABILIZE_DELAY_MS = 3_000;

export interface TransferOptions {
  /** 单轮最多转存几部（0/缺省 = 处理完队列） */
  maxItems?: number;
}

export interface TransferStats {
  attempted: number;
  succeeded: number;
  failed: number;
  covers_mirrored: number;
  credentials_invalid: boolean;
  stopped_reason: "completed" | "budget" | "credential_invalid" | "lease_busy";
  failed_fatal: boolean;
  error?: string;
}

export async function runShortDramaTransfer(
  options: TransferOptions = {}
): Promise<TransferStats> {
  const stats: TransferStats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    covers_mirrored: 0,
    credentials_invalid: false,
    stopped_reason: "completed",
    failed_fatal: false,
  };
  const maxItems = options.maxItems && options.maxItems > 0 ? options.maxItems : Infinity;

  if (!(await tryAcquireShortDramaLease("transfer", TRANSFER_LEASE_TTL_MS))) {
    stats.stopped_reason = "lease_busy";
    stats.failed_fatal = true;
    stats.error = "已有转存任务在运行";
    return stats;
  }

  try {
    const cookie = await getCloudCredentialCookie("quark");
    if (!cookie) {
      stats.stopped_reason = "credential_invalid";
      stats.failed_fatal = true;
      stats.error = "未配置夸克凭证，请先在后台粘贴 cookie";
      return stats;
    }

    // 先把上轮中断遗留的 transferring 复位为 discovered（超过安全时长）
    await recoverStaleTransferring();

    const queue = await takeShortDramasForTransfer(50, MAX_ATTEMPTS);

    for (const drama of queue) {
      if (stats.attempted >= maxItems) {
        stats.stopped_reason = "budget";
        break;
      }

      const result = await transferOne(drama, cookie);
      stats.attempted += 1;
      if (result.ok) {
        stats.succeeded += 1;
        if (result.coverMirrored) stats.covers_mirrored += 1;
      } else {
        stats.failed += 1;
        if (result.credentialInvalid) {
          stats.credentials_invalid = true;
          stats.stopped_reason = "credential_invalid";
          await markCloudCredentialInvalid("quark");
          break;
        }
      }
      await sleep(SAVE_DELAY_MS);
    }

    await updateShortDramaSyncState({
      last_transfer_at: new Date().toISOString(),
      last_transfer_stats: stats as unknown as Record<string, unknown>,
    });
    return stats;
  } catch (error) {
    stats.failed_fatal = true;
    stats.error = error instanceof Error ? error.message : String(error);
    return stats;
  } finally {
    await releaseShortDramaLease("transfer");
  }
}

export interface MetadataBackfillStats {
  attempted: number;
  covers_mirrored: number;
  intros_set: number;
  metadata_set: number;
  /** 跑完后仍缺任一元数据的条目数（源分享可能本就没有三件套） */
  still_missing: number;
  credentials_invalid: boolean;
  stopped_reason:
    | "completed"
    | "budget"
    | "nothing_to_do"
    | "credential_invalid"
    | "lease_busy";
  failed_fatal: boolean;
  error?: string;
}

/**
 * 元数据补齐：对已 done 且有 own_folder_fid 的条目只重列目录、重走
 * 三件套关联（不重复转存、不重建分享），修复转存瞬间夸克索引延迟
 * 导致的封面/简介/metadata 缺失。
 */
export async function runShortDramaMetadataBackfill(
  options: TransferOptions = {}
): Promise<MetadataBackfillStats> {
  const stats: MetadataBackfillStats = {
    attempted: 0,
    covers_mirrored: 0,
    intros_set: 0,
    metadata_set: 0,
    still_missing: 0,
    credentials_invalid: false,
    stopped_reason: "completed",
    failed_fatal: false,
  };
  const maxItems = options.maxItems && options.maxItems > 0 ? options.maxItems : 50;

  if (!(await tryAcquireShortDramaLease("transfer", TRANSFER_LEASE_TTL_MS))) {
    stats.stopped_reason = "lease_busy";
    stats.failed_fatal = true;
    stats.error = "已有转存任务在运行";
    return stats;
  }

  try {
    const cookie = await getCloudCredentialCookie("quark");
    if (!cookie) {
      stats.stopped_reason = "credential_invalid";
      stats.failed_fatal = true;
      stats.error = "未配置夸克凭证，请先在后台粘贴 cookie";
      return stats;
    }

    const queue = await takeShortDramasForMetadataBackfill(maxItems);
    if (queue.length === 0) {
      stats.stopped_reason = "nothing_to_do";
      return stats;
    }

    for (const drama of queue) {
      if (stats.attempted >= maxItems) {
        stats.stopped_reason = "budget";
        break;
      }
      stats.attempted += 1;
      try {
        const meta = await collectMetadata(cookie, drama.own_folder_fid!, drama);
        if (meta.coverUrl) {
          stats.covers_mirrored += 1;
        }
        if (meta.intro) stats.intros_set += 1;
        if (meta.metadata) stats.metadata_set += 1;
        const missingCount = [
          meta.coverUrl ? 0 : 1,
          meta.intro ? 0 : 1,
          meta.metadata ? 0 : 1,
        ].reduce<number>((sum, flag) => sum + flag, 0);
        if (missingCount > 0) stats.still_missing += 1;
        await patchShortDramaTransfer(drama.id, {
          status: "done",
          clear_transfer_error: true,
          ...(meta.coverUrl ? { cover_url: meta.coverUrl } : {}),
          ...(meta.intro ? { intro: meta.intro } : {}),
          ...(meta.metadata ? { metadata: meta.metadata } : {}),
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
          `短剧元数据补齐失败 id=${drama.id}:`,
          error instanceof Error ? error.message : String(error)
        );
        stats.still_missing += 1;
      }
      await sleep(SAVE_DELAY_MS);
    }

    await updateShortDramaSyncState({
      last_metadata_backfill_at: new Date().toISOString(),
      last_metadata_backfill_stats: stats as unknown as Record<string, unknown>,
    });
    return stats;
  } catch (error) {
    stats.failed_fatal = true;
    stats.error = error instanceof Error ? error.message : String(error);
    return stats;
  } finally {
    await releaseShortDramaLease("transfer");
  }
}

interface TransferOneResult {
  ok: boolean;
  coverMirrored: boolean;
  credentialInvalid: boolean;
  error?: string;
}

async function transferOne(
  drama: ShortDrama,
  cookie: string
): Promise<TransferOneResult> {
  if (!drama.source_share_url) {
    await patchShortDramaTransfer(drama.id, {
      status: "invalid",
      transfer_error: "源站详情未发现夸克分享链接",
    });
    return { ok: true, coverMirrored: false, credentialInvalid: false };
  }

  await patchShortDramaTransfer(drama.id, { status: "transferring" });

  try {
    const client = new QuarkApiClient({ cookie });
    const fileName = `${drama.title}${
      drama.episode_count ? `（${drama.episode_count}集）` : ""
    }`;
    const transferred = await client.transferAndShare(
      drama.source_share_url,
      fileName,
      null,
      // 短剧合集是整目录保存，个别违规文件被源站过滤时不应阻塞整部剧
      { allowPartialFiltered: true }
    );
    const folderFid = transferred.savedFids[0];

    // 元数据关联：列目录 → 下载三件套
    let coverMirrored = false;
    try {
      const meta = await collectMetadata(cookie, folderFid, drama);
      coverMirrored = meta.coverMirrored;
      await patchShortDramaTransfer(drama.id, {
        status: "done",
        clear_transfer_error: true,
        own_share_url: transferred.shareLink,
        own_share_code: transferred.shareCode,
        own_folder_fid: folderFid,
        ...(meta.coverUrl ? { cover_url: meta.coverUrl } : {}),
        ...(meta.intro ? { intro: meta.intro } : {}),
        ...(meta.metadata ? { metadata: meta.metadata } : {}),
      });
    } catch (metaError) {
      // 元数据失败不算转存失败：链接已可用，补抓靠重跑流水线
      console.warn(
        `短剧元数据关联失败 id=${drama.id}:`,
        metaError instanceof Error ? metaError.message : String(metaError)
      );
      await patchShortDramaTransfer(drama.id, {
        status: "done",
        clear_transfer_error: true,
        own_share_url: transferred.shareLink,
        own_share_code: transferred.shareCode,
        own_folder_fid: folderFid,
        transfer_error: "元数据关联失败（封面/简介缺失），可用「补齐元数据」重试",
      });
    }

    return { ok: true, coverMirrored, credentialInvalid: false };
  } catch (error) {
    const credentialInvalid = error instanceof QuarkCredentialInvalidError;
    const message = error instanceof Error ? error.message : String(error);
    await patchShortDramaTransfer(drama.id, {
      status: "failed",
      transfer_error: message,
    });
    return { ok: false, coverMirrored: false, credentialInvalid, error: message };
  }
}

interface CollectedMetadata {
  coverMirrored: boolean;
  coverUrl?: string;
  intro?: string;
  metadata?: Record<string, unknown>;
}

async function collectMetadata(
  cookie: string,
  folderFid: string,
  drama: ShortDrama
): Promise<CollectedMetadata> {
  const result: CollectedMetadata = { coverMirrored: false };

  // 夸克 save 是异步落库：API 返回后立刻列目录可能只见部分文件
  // （三件套按名称序排在 mp4 之后，最容易还没索引出来）。轮询到
  // 条目数稳定或出现「metadata.json」为止。
  let items = await listQuarkOwnDirectory(cookie, folderFid);
  for (
    let attempt = 0;
    attempt < METADATA_LIST_STABILIZE_POLLS &&
    !items.some((item) => !item.dir && item.name.toLowerCase() === "metadata.json");
    attempt += 1
  ) {
    await sleep(METADATA_LIST_STABILIZE_DELAY_MS);
    const next = await listQuarkOwnDirectory(cookie, folderFid);
    if (next.length === items.length) break;
    items = next;
  }
  const hasMetadataJson = items.some(
    (item) => !item.dir && item.name.toLowerCase() === "metadata.json"
  );
  if (!hasMetadataJson) {
    console.warn(
      `短剧元数据 id=${drama.id}: 转存目录 ${items.length} 项未见三件套（可能仍在校验/过滤中）`
    );
  }
  const cover = items.find(
    (item) => !item.dir && /^封面\.(jpe?g|png|webp)$/i.test(item.name)
  );
  const metadataFile = items.find(
    (item) => !item.dir && item.name.toLowerCase() === "metadata.json"
  );
  const introFile = items.find(
    (item) => !item.dir && /^简介\.txt$/i.test(item.name)
  );

  if (cover) {
    const download = await fetchQuarkDownloadUrlForFile(cookie, cover.fid);
    const bytes = await fetchSignedDownloadBytes(download.downloadUrl, undefined, cookie);
    if (bytes) {
      const ext = extensionForContentType(bytes.contentType, cover.name);
      const coverUrl = await uploadCoverToR2({
        // coverObjectKey 会再拼顶层前缀（CLOUDFLARE_R2_KEY_PREFIX 或
        // 缺省 short-drama-covers），这里只传文件键
        key: `${drama.source_article_id}.${ext}`,
        body: bytes.body,
        contentType: bytes.contentType,
      });
      if (coverUrl) {
        result.coverUrl = coverUrl;
        result.coverMirrored = true;
      }
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

  return result;
}

/** 上轮中断的 transferring 复位（租约过期后仍未完成的都算） */
async function recoverStaleTransferring(): Promise<void> {
  const state = await getShortDramaSyncState();
  if (!state?.running || state.running.task !== "transfer") return;
  // 流水线自身持租约期间不会走到这里（takeShortDramasForTransfer 也会排除 transferring），
  // 这里主要兜底进程崩溃后残留的 transferring 状态。
  const { getDatabase } = await import("@/lib/db");
  const { COLLECTIONS } = await import("@/lib/constants/db");
  const db = await getDatabase();
  await db
    .collection(COLLECTIONS.SHORT_DRAMAS)
    .updateMany(
      {
        status: "transferring",
        updated_at: {
          $lt: new Date(Date.now() - TRANSFER_DELAY_SAFETY_MS).toISOString(),
        },
      },
      { $set: { status: "discovered", updated_at: new Date().toISOString() } }
    );
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

