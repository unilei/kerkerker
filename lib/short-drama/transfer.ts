import { QuarkApiClient } from "@/lib/quark/quark-api-client";
import {
  fetchQuarkDownloadUrlForFile,
  listQuarkOwnDirectory,
  QuarkCredentialInvalidError,
} from "@/lib/quark/quark-api-client";
import {
  getCloudCredentialCookie,
  refreshQuarkCredentialPuus,
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
  consumeShortDramaTaskCancel,
  getShortDramaSyncState,
  getShortDramasByIds,
  deleteShortDramasByIds,
  listShortDramas,
  updateShortDramaLeaseProgress,
} from "@/lib/short-drama-db";
import type { ShortDrama, ShortDramaMetadataPiece, ShortDramaStatus } from "@/types/short-drama";
import {
  queuePublishedDramaUrl,
  flushQueuedDramaUrls,
} from "@/lib/seo-push";

/**
 * 短剧转存流水线
 *
 * 每部短剧：
 *   1. 用已移植的 QuarkApiClient.transferAndShare 把源站夸克分享
 *      整体转存到自己网盘并生成自己的分享链接（kkpan 同款流程，串行防风控）。
 *   2. 定位转存出的剧名目录（save 返回的 savedFids 即目录 fid）。
 *   3. 列目录（按分页证据翻到底，元数据文件排在列表最底部）按类型找
 *      图片 / 文本 / JSON 三件套，优先精确命名（封面.* / 简介.txt /
 *      metadata.json），命名不固定时退回同类型任意文件：
 *      - 图片：签名直链下载 → R2 镜像（未配置 R2 时跳过，封面留空）
 *      - JSON：下载并 JSON 解析（坏 JSON 原文丢弃）
 *      - 文本：下载按 UTF-8 解码
 *   4. 状态机回写 done / failed；凭证失效时标记凭证并整轮中止。
 *
 * transferAndShare 的保存边界策略会把"剧名目录"整体作为 save 单元，
 * savedFids[0] 即自己网盘中的目录 fid，可直接 file/sort 列内部文件。
 */

const TRANSFER_LEASE_TTL_MS = 60 * 60 * 1_000;
const SAVE_DELAY_MS = 3_000;
const MAX_ATTEMPTS = 3;
const TRANSFER_DELAY_SAFETY_MS = 10 * 60 * 1_000;
const PROGRESS_EXTEND_TTL_MS = 60 * 60 * 1_000;
// 进度写库节流：转存单部要数十秒，页面 3s 轮询下每次事件都写也够低频
const PROGRESS_WRITE_INTERVAL_MS = 3_000;

let lastTransferProgressWriteAt = 0;
async function reportTransferProgress(
  stage: string,
  message: string,
  done?: number,
  total?: number
): Promise<void> {
  const now = Date.now();
  if (now - lastTransferProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
  lastTransferProgressWriteAt = now;
  await updateShortDramaLeaseProgress("transfer", { stage, message, done, total }, {
    extendTtlMs: PROGRESS_EXTEND_TTL_MS,
  });
}
// 夸克 save 异步落库的索引等待：每 3s 重列一次目录，最多 5 次（约 15s）
const METADATA_LIST_STABILIZE_POLLS = 5;
const METADATA_LIST_STABILIZE_DELAY_MS = 3_000;

// 单部看门狗：单部的全部网络步骤都有各自的 fetch 超时，但系统层
// （如无超时的 DNS 解析挂起）仍可能让 Promise 永不落地，整轮任务
// 静默停摆（2026-09 实测：20 分钟零推进）。正常单部 10~30s，10 分钟
// 是宽裕上界；触发即本部按失败处理、继续下一部，不再拖死整轮。
const PER_ITEM_WATCHDOG_MS = 10 * 60 * 1_000;

class WatchdogTimeoutError extends Error {
  constructor(ms: number) {
    super(`单部处理超过看门狗时限（${Math.round(ms / 1000)}s），按失败跳过`);
    this.name = "WatchdogTimeoutError";
  }
}

/** 给单部处理加超时竞速；超时抛 WatchdogTimeoutError（不取消底层操作）。
 *  导出供单测直测时序语义。 */
export async function withWatchdog<T>(
  promise: Promise<T>,
  ms: number = PER_ITEM_WATCHDOG_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WatchdogTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface TransferOptions {
  /** 单轮最多转存几部（0/缺省 = 处理完队列） */
  maxItems?: number;
  /** 指定转存这些短剧（后台单个/批量转存）；优先于队列，上限 50，
   *  已 done/invalid/transferring 的会被跳过（不重复转存） */
  ids?: string[];
  /** 按「待转存数据」Tab 的页码范围取队列：与该视图同一套查询
   *  （发布日期新→旧、30 条/页，可叠加搜索与状态筛选），先转最新发布。
   *  语义优先级低于 ids。 */
  queuePages?: {
    start: number;
    end: number;
    search?: string;
    statuses?: ShortDramaStatus[];
  };
}

export interface TransferStats {
  attempted: number;
  succeeded: number;
  failed: number;
  covers_mirrored: number;
  credentials_invalid: boolean;
  stopped_reason: "completed" | "budget" | "cancelled" | "credential_invalid" | "lease_busy";
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
    // __puus（CDN 下载签名）寿命只有 1-2 天，转存时要下载封面/简介/metadata，
    // 先续期再开工（6 小时内跑过的任务直接沿用，不额外打接口）
    const cookie = await refreshQuarkCredentialPuus();
    if (!cookie) {
      stats.stopped_reason = "credential_invalid";
      stats.failed_fatal = true;
      stats.error = "未配置夸克凭证，请先在后台粘贴 cookie";
      return stats;
    }

    // 先把上轮中断遗留的 transferring 复位为 discovered（超过安全时长）
    await recoverStaleTransferring();

    let queue: ShortDrama[];
    if (options.ids && options.ids.length > 0) {
      const wanted = new Set(options.ids);
      queue = (await getShortDramasByIds(options.ids)).filter(
        (drama) =>
          wanted.has(drama.id) &&
          drama.enabled &&
          drama.status !== "done" &&
          drama.status !== "invalid" &&
          drama.status !== "transferring" &&
          !!drama.source_share_url
      );
    } else if (options.queuePages) {
      // 页码范围转存：与待转存 Tab 同一套排序/分页（发布日期新→旧），
      // 单页 30 条与列表一致；上限 50 页防误操作（约 1500 部）
      const { start, end, search, statuses } = options.queuePages;
      const pageStart = Math.max(1, Math.floor(start));
      const pageEnd = Math.min(Math.max(pageStart, Math.floor(end)), pageStart + 49);
      const pageSize = 30;
      const maxItems = 50 * pageSize;
      const result = await listShortDramas({
        statuses: statuses && statuses.length > 0 ? statuses : ["discovered", "failed"],
        includeDisabled: true,
        ...(search ? { search } : {}),
        page: pageStart,
        limit: (pageEnd - pageStart + 1) * pageSize,
        // listShortDramas 默认把 limit 钳到 100（公开接口防大查询），
        // 不覆写的话选 1-20 页只会取到前 100 条
        limitMax: maxItems,
      });
      queue = result.dramas.slice(0, maxItems);
    } else {
      queue = await takeShortDramasForTransfer(50, MAX_ATTEMPTS);
    }

    // 新一轮任务强制写第一条进度（清掉上一轮遗留的节流时间戳）
    lastTransferProgressWriteAt = 0;
    // 清掉可能残留的取消标记（上轮取消未被循环消费时，不能让新任务秒停）
    await consumeShortDramaTaskCancel("transfer");
    const plannedTotal = Math.min(queue.length, maxItems);
    for (const [queueIndex, drama] of queue.entries()) {
      // 取消检查点：当前这部剧跑完、不再取下一条（转存不可半途中断）
      if (await consumeShortDramaTaskCancel("transfer")) {
        stats.stopped_reason = "cancelled";
        reportTransferProgress("transfer", "已取消：完成本轮当前条目后停止", queueIndex, plannedTotal);
        break;
      }
      if (stats.attempted >= maxItems) {
        stats.stopped_reason = "budget";
        break;
      }
      reportTransferProgress(
        "transfer",
        `转存（${queueIndex + 1}/${plannedTotal}）：${
          drama.title
        }${drama.episode_count ? `（${drama.episode_count}集）` : ""}`,
        queueIndex + 1,
        plannedTotal
      );
      // transferOne 自身吞错返回结果；这里只兜看门狗超时——单部卡死
      // 按失败计并继续，不拖死整轮（其余异常照旧上抛走 fatal）
      let result: TransferOneResult;
      try {
        result = await withWatchdog(transferOne(drama, cookie));
      } catch (error) {
        if (!(error instanceof WatchdogTimeoutError)) throw error;
        console.warn(`短剧转存看门狗超时 id=${drama.id} ${drama.title}`);
        result = {
          ok: false,
          coverMirrored: false,
          credentialInvalid: false,
          error: error.message,
        };
      }
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
    // 本轮新发布的详情页 URL 批量推送搜索引擎（尽力而为，失败不影响任务）
    await flushQueuedDramaUrls();
    await releaseShortDramaLease("transfer");
  }
}

export interface MetadataBackfillStats {
  attempted: number;
  covers_mirrored: number;
  intros_set: number;
  metadata_set: number;
  /** 三件套全部补齐的条目数（本轮后已完整） */
  resolved: number;
  /** 仍有「可重试缺失」的条目数（下载失败/索引延迟等，留在队列下轮再试） */
  still_missing: number;
  /** 缺失部件全部核实为「源分享夹里本就没有」的条目数（已写
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

/**
 * 元数据补齐：对已 done 且有 own_folder_fid 的条目只重列目录、重走
 * 三件套关联（不重复转存、不重建分享），修复转存瞬间夸克索引延迟
 * 导致的封面/简介/metadata 缺失。目录里确认源站本就没有的部件写入
 * missing_at_source 终结标记并豁免出队（转存目录是静态副本，重试无果）。
 * maxItems 0/缺省 = 处理完整个队列（与转存同语义；全量请走 background）。
 */
export async function runShortDramaMetadataBackfill(
  options: TransferOptions = {}
): Promise<MetadataBackfillStats> {
  const stats: MetadataBackfillStats = {
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

  if (!(await tryAcquireShortDramaLease("transfer", TRANSFER_LEASE_TTL_MS))) {
    stats.stopped_reason = "lease_busy";
    stats.failed_fatal = true;
    stats.error = "已有转存任务在运行";
    return stats;
  }

  try {
    // 元数据回填全靠 CDN 下载三件套，__puus 过期会让每条都静默拿不到
    const cookie = await refreshQuarkCredentialPuus();
    if (!cookie) {
      stats.stopped_reason = "credential_invalid";
      stats.failed_fatal = true;
      stats.error = "未配置夸克凭证，请先在后台粘贴 cookie";
      return stats;
    }

    const queue = await takeShortDramasForMetadataBackfill(
      Number.isFinite(maxItems) ? maxItems : 50_000
    );
    if (queue.length === 0) {
      stats.stopped_reason = "nothing_to_do";
      return stats;
    }

    lastTransferProgressWriteAt = 0;
    // 清掉可能残留的取消标记（与转存循环同语义）
    await consumeShortDramaTaskCancel("transfer");
    const plannedTotal = Math.min(queue.length, maxItems);
    for (const [queueIndex, drama] of queue.entries()) {
      // 取消检查点（与转存循环同语义）
      if (await consumeShortDramaTaskCancel("transfer")) {
        stats.stopped_reason = "cancelled";
        reportTransferProgress("metadata_backfill", "已取消：停止补齐", queueIndex, plannedTotal);
        break;
      }
      if (stats.attempted >= maxItems) {
        stats.stopped_reason = "budget";
        break;
      }
      stats.attempted += 1;
      reportTransferProgress(
        "metadata_backfill",
        `补齐元数据（${queueIndex + 1}/${plannedTotal}）：${
          drama.title
        }${drama.episode_count ? `（${drama.episode_count}集）` : ""}`,
        queueIndex + 1,
        plannedTotal
      );
      try {
        const meta = await withWatchdog(
          collectMetadata(cookie, drama.own_folder_fid!, drama)
        );
        if (meta.coverUrl) {
          stats.covers_mirrored += 1;
        }
        if (meta.intro) stats.intros_set += 1;
        if (meta.metadata) stats.metadata_set += 1;
        // 按部件分类缺失去向：本轮列目录确认源里没有的（sourceMissing）
        // 会被标记终结；仅剩源缺失的条目出队，仍有可重试缺失的留在队列
        const sourceMissing = meta.sourceMissing ?? [];
        const anyMissing =
          !meta.coverUrl || !meta.intro || !meta.metadata;
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
        await patchShortDramaTransfer(drama.id, {
          status: "done",
          clear_transfer_error: true,
          ...(meta.coverUrl ? { cover_url: meta.coverUrl } : {}),
          ...(meta.intro ? { intro: meta.intro } : {}),
          ...(meta.metadata ? { metadata: meta.metadata } : {}),
          ...(meta.sourceMissing ? { missing_at_source: meta.sourceMissing } : {}),
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
        // 看门狗超时留给下轮重试（底层操作无法取消，放弃等待即可）
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

// ---------------------------------------------------------------------------
// 删除流水线：先删自己夸克网盘的转存目录（分享随目录失效），网盘清理
// 成功（或本就没有转存物）才删本地记录，避免「分享还在、本地记录没了」
// 的孤儿状态。持有转存租约，与转存/补齐任务互斥；串行防风控。
// ---------------------------------------------------------------------------

const DELETE_LEASE_TTL_MS = 30 * 60 * 1_000;
const DELETE_DELAY_MS = 1_500;
// 删除只调夸克删除接口 + 轮询任务状态，单条远快于转存，看门狗收窄到 5 分钟
const DELETE_WATCHDOG_MS = 5 * 60 * 1_000;

export interface DeletionStats {
  attempted: number;
  /** 网盘 + 本地记录都已删除的条数 */
  succeeded: number;
  failed: number;
  /** 网盘里没有转存物（未转存过/已清理），只删了本地记录的条数 */
  local_only: number;
  credentials_invalid: boolean;
  stopped_reason: "completed" | "nothing_to_do" | "lease_busy" | "credential_invalid";
  failed_fatal: boolean;
  error?: string;
  /** 单条失败明细（网盘删除失败会保留本地记录供重试） */
  failures: Array<{ id: string; title: string; error: string }>;
}

export async function runShortDramaDeletion(ids: string[]): Promise<DeletionStats> {
  const stats: DeletionStats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    local_only: 0,
    credentials_invalid: false,
    stopped_reason: "completed",
    failed_fatal: false,
    failures: [],
  };

  const capped = (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === "string" && id.length > 0)
    .slice(0, 50);
  if (capped.length === 0) {
    stats.stopped_reason = "nothing_to_do";
    stats.error = "未指定要删除的短剧";
    return stats;
  }

  if (!(await tryAcquireShortDramaLease("transfer", DELETE_LEASE_TTL_MS))) {
    stats.stopped_reason = "lease_busy";
    stats.failed_fatal = true;
    stats.error = "已有转存类任务在运行，稍后再试";
    return stats;
  }

  try {
    const cookie = await getCloudCredentialCookie("quark");
    if (!cookie) {
      stats.stopped_reason = "credential_invalid";
      stats.failed_fatal = true;
      stats.error = "未配置夸克凭证，无法清理网盘文件";
      return stats;
    }

    const dramas = await getShortDramasByIds(capped);
    if (dramas.length === 0) {
      stats.stopped_reason = "nothing_to_do";
      stats.error = "指定的短剧不存在或已删除";
      return stats;
    }

    lastTransferProgressWriteAt = 0;
    for (const [index, drama] of dramas.entries()) {
      stats.attempted += 1;
      reportTransferProgress(
        "delete",
        `删除（${index + 1}/${dramas.length}）：${
          drama.title
        }${drama.episode_count ? `（${drama.episode_count}集）` : ""}`,
        index + 1,
        dramas.length
      );
      try {
        const removedFromPan = await withWatchdog(
          deleteQuarkObjects(cookie, drama),
          DELETE_WATCHDOG_MS
        );
        // 网盘清理完成（或本来就没有转存物）才删本地记录
        await deleteShortDramasByIds([drama.id]);
        if (removedFromPan) stats.succeeded += 1;
        else stats.local_only += 1;
      } catch (error) {
        if (error instanceof QuarkCredentialInvalidError) {
          stats.credentials_invalid = true;
          stats.stopped_reason = "credential_invalid";
          stats.failed_fatal = true;
          stats.error = error.message;
          await markCloudCredentialInvalid("quark");
          break;
        }
        // 网盘删除失败：保留本地记录，修正错误后可重试
        stats.failed += 1;
        stats.failures.push({
          id: drama.id,
          title: drama.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(DELETE_DELAY_MS);
    }
    return stats;
  } catch (error) {
    stats.failed_fatal = true;
    stats.error = error instanceof Error ? error.message : String(error);
    return stats;
  } finally {
    await releaseShortDramaLease("transfer");
  }
}

/** 删自己网盘里的转存目录；没有可删对象（未转存过）返回 false */
async function deleteQuarkObjects(cookie: string, drama: ShortDrama): Promise<boolean> {
  const client = new QuarkApiClient({ cookie });
  if (drama.own_folder_fid) {
    await client.deleteOwnedFilesByFids([drama.own_folder_fid]);
    return true;
  }
  if (drama.own_share_url) {
    await client.deleteOwnedFilesByShareLink(drama.own_share_url);
    return true;
  }
  return false;
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
      // 自身分享链接已可用 → 详情页正式可公开访问，入搜索引擎推送缓冲
      //（任务收尾统一 flush；invalid/failed 路径不推）
      queuePublishedDramaUrl(drama.id);
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
      // 链接已可用只是元数据没补齐，详情页同样可公开访问 → 推送缓冲
      queuePublishedDramaUrl(drama.id);
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
  /**
   * 列目录确认「源分享夹里根本没有该类型文件」的三件套部件。仅当目录
   * 里能看到剧集视频文件（列目录确有其物、不是空/截断响应）才报告，
   * 供补齐任务写终结标记；下载失败/解析失败不算缺失（可重试）。
   */
  sourceMissing?: ShortDramaMetadataPiece[];
}

// 元数据三件套按类型识别（分享夹里命名不固定，未必叫 封面/简介/metadata.json，
// 且排在剧集合集文件列表的最底部），优先精确命名，缺失时退回同类型任意文件
const IMAGE_FILE_PATTERN = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const TEXT_FILE_PATTERN = /\.(txt|md)$/i;
const JSON_FILE_PATTERN = /\.json$/i;
// 剧集视频文件：源缺失核实的「目录确有其物」证据（无视频时列目录结果
// 不可信——可能整目录被过滤/空目录，不能据此判定三件套缺失）
const VIDEO_FILE_PATTERN = /\.(mp4|mkv|ts|flv|mov|m4v)$/i;

function isMetadataFileName(name: string): boolean {
  return (
    IMAGE_FILE_PATTERN.test(name) ||
    TEXT_FILE_PATTERN.test(name) ||
    JSON_FILE_PATTERN.test(name)
  );
}

/**
 * 列转存目录并抓取三件套（封面→R2 镜像、简介、metadata JSON）。
 * 转存流水线与元数据补齐共用的内部步骤；返回值带 sourceMissing
 * （本轮列目录确认源分享夹里不存在的部件）供补齐写终结标记。
 */
export async function collectMetadata(
  cookie: string,
  folderFid: string,
  drama: ShortDrama
): Promise<CollectedMetadata> {
  const result: CollectedMetadata = { coverMirrored: false };

  // 夸克 save 是异步落库：API 返回后立刻列目录可能只见部分文件
  // （三件套按名称序排在 mp4 之后、位于列表最底部，最容易还没索引出来）。
  // 轮询到出现图片/文本/JSON 类文件或条目数稳定为止。
  let items = await listQuarkOwnDirectory(cookie, folderFid);
  for (
    let attempt = 0;
    attempt < METADATA_LIST_STABILIZE_POLLS &&
    !items.some((item) => !item.dir && isMetadataFileName(item.name));
    attempt += 1
  ) {
    await sleep(METADATA_LIST_STABILIZE_DELAY_MS);
    const next = await listQuarkOwnDirectory(cookie, folderFid);
    if (next.length === items.length) break;
    items = next;
  }
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
  // 却没有任何对应类型文件 → 该部件在源分享夹里就不存在，重试无意义
  const sourceMissing: ShortDramaMetadataPiece[] = [];
  if (files.some((item) => VIDEO_FILE_PATTERN.test(item.name))) {
    if (imageFiles.length === 0) sourceMissing.push("cover");
    if (textFiles.length === 0) sourceMissing.push("intro");
    if (jsonFiles.length === 0) sourceMissing.push("metadata");
  }
  const cover =
    imageFiles.find((item) => /封面|cover|poster/i.test(item.name)) ?? imageFiles[0];
  const metadataFile =
    jsonFiles.find((item) => item.name.toLowerCase() === "metadata.json") ??
    jsonFiles[0];
  const introFile =
    textFiles.find((item) => /简介|intro/i.test(item.name)) ?? textFiles[0];

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

  if (sourceMissing.length > 0) result.sourceMissing = sourceMissing;
  return result;
}

/** 上轮中断的 transferring 复位（租约过期后仍未完成的都算） */
async function recoverStaleTransferring(): Promise<void> {
  const state = await getShortDramaSyncState();
  if (!state?.running_transfer) return;
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

