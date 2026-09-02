import { DUANJUGOU_SOURCE, scrapeListPage, scrapeDetail, scrapeSearch, parseDramaTitle, scrapeTagGroups } from "@/lib/short-drama/duanjugou";
import {
  upsertShortDramaFromScrape,
  getShortDramaBySourceArticleId,
  appendShortDramaTags,
  getShortDramaSyncState,
  updateShortDramaSyncState,
  tryAcquireShortDramaLease,
  releaseShortDramaLease,
  consumeShortDramaTaskCancel,
  updateShortDramaLeaseProgress,
} from "@/lib/short-drama-db";
import { detectPanBrand } from "@/lib/pan-brand";

/**
 * 短剧抓取引擎：全量回填 / 增量跟更 / 标签回填
 *
 * 水位语义（吸取 kkpan 同步的教训，ID 不是时间、预算中断不能推高水位）：
 * - last_article_watermark = 「详情已成功处理（或确认已含源链接）」的最大文章 ID。
 *   列表页按发布时间倒序、文章 ID 按发布顺序递增，比水位旧的即增量已覆盖。
 * - 详情预算中断时水位只推进到已处理最大 ID，剩余旧文靠下次回填补齐；
 *   回填重跑时对「已有源链接」的条目跳过详情抓取，因此续跑很轻。
 * - 增量模式遇到整页都比水位旧即停；失败条目不推进水位，下轮自然重试。
 */

const PAGE_DELAY_MS = 1_000;
const DETAIL_DELAY_MS = 200;
const LEASE_TTL_MS = 30 * 60 * 1_000;
const PROGRESS_EXTEND_TTL_MS = 30 * 60 * 1_000;
// 进度写库节流：每次写都是一次 Mongo update，低频轮询展示够用即可
const PROGRESS_WRITE_INTERVAL_MS = 3_000;

let lastScrapeProgressWriteAt = 0;
async function reportScrapeProgress(
  stage: string,
  message: string,
  done?: number,
  total?: number
): Promise<void> {
  const now = Date.now();
  if (now - lastScrapeProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
  lastScrapeProgressWriteAt = now;
  await updateShortDramaLeaseProgress("scrape", { stage, message, done, total }, {
    extendTtlMs: PROGRESS_EXTEND_TTL_MS,
  });
}

export interface ScrapeOptions {
  mode: "backfill" | "incremental";
  /** 单轮最大列表页数（0/缺省 = 跟随站点 maxPage） */
  maxPages?: number;
  /** 单轮详情抓取上限（0/缺省 = 不限），首次回填可分批执行 */
  maxDetails?: number;
  /** 起始列表页（仅 backfill 生效，配合 last_page 做断点续跑；
   *  incremental 固定从第 1 页向水位翻页，跳页会漏抓新条目） */
  startPage?: number;
}

export interface ScrapeStats {
  mode: "backfill" | "incremental";
  pages_scraped: number;
  site_max_page: number;
  /** 本轮最后到达的列表页；预算中断时即下轮回填的 startPage 建议值 */
  last_page: number;
  items_seen: number;
  items_skipped_existing: number;
  items_skipped_old: number;
  items_created: number;
  items_updated: number;
  details_fetched: number;
  details_with_quark: number;
  failed_pages: number;
  failed_details: number;
  /** 本轮从断点页续跑时的起始页（1 = 全新开始） */
  resumed_from_page?: number;
  stopped_reason:
    | "completed"
    | "watermark"
    | "budget_pages"
    | "budget_details"
    | "empty_page"
    | "cancelled";
  watermark_before: number;
  watermark_after: number;
  failed: boolean;
  error?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runShortDramaScrape(
  options: ScrapeOptions
): Promise<ScrapeStats> {
  const stats: ScrapeStats = {
    mode: options.mode,
    pages_scraped: 0,
    site_max_page: 1,
    items_seen: 0,
    items_skipped_existing: 0,
    items_skipped_old: 0,
    items_created: 0,
    items_updated: 0,
    details_fetched: 0,
    details_with_quark: 0,
    failed_pages: 0,
    failed_details: 0,
    last_page: 0,
    stopped_reason: "completed",
    watermark_before: 0,
    watermark_after: 0,
    failed: false,
  };

  if (!(await tryAcquireShortDramaLease("scrape", LEASE_TTL_MS))) {
    stats.failed = true;
    stats.error = "已有抓取任务在运行";
    return stats;
  }

  try {
    const state = await getShortDramaSyncState();
    const watermark = state?.last_article_watermark ?? 0;
    stats.watermark_before = watermark;
    const incremental = options.mode === "incremental";
    const maxPages = options.maxPages && options.maxPages > 0 ? options.maxPages : Infinity;
    const maxDetails = options.maxDetails && options.maxDetails > 0 ? options.maxDetails : Infinity;

    const processedIds: number[] = [];
    let detailsFetched = 0;
    // 断点续跑：显式 startPage（脚本/curl 传参）优先；否则读上一轮
    // 回填预算中断遗留的断点页，UI 重启不再从第 1 页重新翻站
    const resumePage = !incremental && !(options.startPage && options.startPage > 0)
      ? state?.last_backfill_resume_page ?? 0
      : 0;
    if (resumePage > 1) stats.resumed_from_page = resumePage;
    const startPage = !incremental && options.startPage && options.startPage > 0
      ? Math.floor(options.startPage)
      : Math.max(1, resumePage);
    let page = startPage;
    let siteMaxPage = page;
    // 清掉可能残留的取消标记（上轮取消未被消费时不能让新任务秒停）
    await consumeShortDramaTaskCancel("scrape");

    while (page <= Math.min(siteMaxPage, maxPages)) {
      // 取消检查点：整页边界优雅停（当前页处理完后不再翻页）
      if (await consumeShortDramaTaskCancel("scrape")) {
        stats.stopped_reason = "cancelled";
        break;
      }
      let items;
      try {
        const result = await scrapeListPage(page);
        items = result.items;
        siteMaxPage = Math.max(siteMaxPage, result.maxPage);
        stats.pages_scraped += 1;
      } catch (error) {
        stats.failed_pages += 1;
        console.warn(
          `短剧列表页 ${page} 抓取失败:`,
          error instanceof Error ? error.message : String(error)
        );
        // 尚未成功抓到任何列表页时的失败视为上游不可用（含 startPage 起点页）
        if (stats.pages_scraped === 0) throw error;
        await sleep(PAGE_DELAY_MS);
        page += 1;
        continue;
      }

      if (items.length === 0) {
        // 首页/正常列表页不该为空：空页大概率是 WAF 检测页混过了解析
        // （HTTP 200 但内容不对）。重试一次，仍为空则按失败处理而不是
        // 静默当"空页完成"——否则增量会假成功、看起来"不起作用"。
        if (stats.pages_scraped > 0 && stats.failed_pages < 2) {
          stats.failed_pages += 1;
          console.warn(`短剧列表页 ${page} 解析出 0 条，疑似 WAF 页，重试一次`);
          await sleep(PAGE_DELAY_MS);
          continue;
        }
        stats.stopped_reason = "empty_page";
        break;
      }
      stats.items_seen += items.length;
      reportScrapeProgress(
        "scrape_page",
        `列表页 ${page}/${siteMaxPage}：本页 ${items.length} 条`,
        stats.pages_scraped,
        siteMaxPage
      );

      let pageMinId = Infinity;

      for (const item of items) {
        const articleId = Number(item.article_id);
        if (!Number.isSafeInteger(articleId)) continue;
        pageMinId = Math.min(pageMinId, articleId);

        if (incremental && articleId <= watermark) continue;

        // 已有源链接的条目跳过详情抓取（回填续跑/重复扫描的关键加速）；
        // 详情曾抓过（已拿到发布日期）但源站没有夸克链接的条目同样跳过：
        // 否则多轮回填会被这些条目反复吃掉详情预算，永远翻不到新页。
        // 极小代价：源站事后补挂夸克链接的旧文需删除本地记录后重抓。
        const existing = await getShortDramaBySourceArticleId(
          DUANJUGOU_SOURCE,
          item.article_id
        );
        if (existing && (existing.source_share_url || existing.publish_date)) {
          stats.items_skipped_existing += 1;
          processedIds.push(articleId);
          continue;
        }

        if (detailsFetched >= maxDetails) break;

        try {
          const detail = await scrapeDetail(item.article_id);
          detailsFetched += 1;
          stats.details_fetched += 1;
          if (!detail) {
            stats.failed_details += 1;
            reportScrapeProgress(
              "scrape_detail",
              `详情 ${item.article_id} 解析失败`,
              detailsFetched
            );
            continue;
          }

          const quarkLink = detail.pan_links.find(
            (link) => detectPanBrand(link.url) === "quark"
          );
          if (quarkLink) stats.details_with_quark += 1;

          const parsed = parseDramaTitle(detail.title || item.title);
          const upsert = await upsertShortDramaFromScrape({
            source: DUANJUGOU_SOURCE,
            source_article_id: item.article_id,
            title: parsed.title,
            episode_count: parsed.episode_count,
            tags: [],
            source_share_url: quarkLink?.url,
            publish_date: detail.publish_date,
          });
          if (upsert.created) stats.items_created += 1;
          else stats.items_updated += 1;
          processedIds.push(articleId);
          reportScrapeProgress(
            "scrape_detail",
            `详情 ${detailsFetched}${
              Number.isFinite(maxDetails) ? `/${maxDetails}` : ""
            }：《${parsed.title.slice(0, 30)}》`,
            detailsFetched,
            Number.isFinite(maxDetails) ? maxDetails : undefined
          );
        } catch (error) {
          stats.failed_details += 1;
          console.warn(
            `短剧详情 ${item.article_id} 抓取失败:`,
            error instanceof Error ? error.message : String(error)
          );
        }
        await sleep(DETAIL_DELAY_MS);
      }

      // 详情预算耗尽：本轮到此为止（剩余靠下次回填/增量续跑）
      if (detailsFetched >= maxDetails) {
        stats.stopped_reason = "budget_details";
        break;
      }

      if (
        incremental &&
        Number.isFinite(pageMinId) &&
        pageMinId <= watermark
      ) {
        stats.stopped_reason = "watermark";
        break;
      }

      if (page >= siteMaxPage) {
        break;
      }
      if (page >= maxPages) {
        stats.stopped_reason = "budget_pages";
        break;
      }

      page += 1;
      await sleep(PAGE_DELAY_MS);
    }

    stats.last_page = page;
    stats.site_max_page = siteMaxPage;

    // 水位只由成功处理的条目推进（失败条目下轮重试）
    const maxProcessed = processedIds.length > 0 ? Math.max(...processedIds) : 0;
    if (maxProcessed > watermark) {
      await updateShortDramaSyncState({ last_article_watermark: maxProcessed });
      stats.watermark_after = maxProcessed;
    } else {
      stats.watermark_after = watermark;
    }

    // 回填断点：预算中断存 last_page 供下轮自动续跑；跑完全站则清除
    if (options.mode === "backfill") {
      const interrupted =
        stats.stopped_reason === "budget_details" ||
        stats.stopped_reason === "budget_pages";
      await updateShortDramaSyncState({
        last_backfill_resume_page: interrupted ? stats.last_page : null,
      });
    }

    await updateShortDramaSyncState({
      last_scrape_at: new Date().toISOString(),
      last_scrape_mode: options.mode,
      last_scrape_stats: stats as unknown as Record<string, unknown>,
    });

    if (stats.pages_scraped === 0) {
      stats.failed = true;
      stats.error = "duanjugou 列表页全部请求失败";
    }
    return stats;
  } catch (error) {
    stats.failed = true;
    stats.error = error instanceof Error ? error.message : String(error);
    return stats;
  } finally {
    await releaseShortDramaLease("scrape");
  }
}

// ---------------------------------------------------------------------------
// 标签回填：把源站标签体系（搜索词）逐词搜索命中到本地短剧
// ---------------------------------------------------------------------------

export interface TagSyncOptions {
  /** 单轮每标签最大搜索页数（每页约 100 条） */
  maxPagesPerTag?: number;
  /** 只处理这些标签（缺省 = 源站全部标签分组） */
  tags?: string[];
}

export interface TagSyncStats {
  tags_total: number;
  tags_processed: number;
  pages_scraped: number;
  dramas_tagged: number;
  failed_tags: number;
  failed: boolean;
  error?: string;
}

export async function runShortDramaTagSync(
  options: TagSyncOptions = {}
): Promise<TagSyncStats> {
  const stats: TagSyncStats = {
    tags_total: 0,
    tags_processed: 0,
    pages_scraped: 0,
    dramas_tagged: 0,
    failed_tags: 0,
    failed: false,
  };
  const maxPagesPerTag = options.maxPagesPerTag && options.maxPagesPerTag > 0
    ? options.maxPagesPerTag
    : 10;

  if (!(await tryAcquireShortDramaLease("scrape", LEASE_TTL_MS))) {
    stats.failed = true;
    stats.error = "已有抓取任务在运行";
    return stats;
  }

  try {
    let tagGroups: Array<{ category: string; tags: string[] }>;
    try {
      tagGroups = (await scrapeTagGroups()).groups;
    } catch (error) {
      stats.failed = true;
      stats.error = `标签体系抓取失败: ${error instanceof Error ? error.message : String(error)}`;
      return stats;
    }

    const wanted = options.tags && options.tags.length > 0 ? new Set(options.tags) : null;
    const allTags = tagGroups.flatMap((group) => group.tags).filter((tag) => !wanted || wanted.has(tag));
    stats.tags_total = allTags.length;

    for (const [tagIndex, tag] of allTags.entries()) {
      let tagged = 0;
      try {
        for (let page = 1; page <= maxPagesPerTag; page += 1) {
          const { items } = await scrapeSearch(tag, page);
          stats.pages_scraped += 1;
          reportScrapeProgress(
            "tag_sync",
            `标签回填 ${tagIndex + 1}/${allTags.length}：「${tag}」第 ${page} 页`,
            tagIndex + 1,
            allTags.length
          );
          if (items.length === 0) break;
          for (const item of items) {
            const modified = await appendShortDramaTags(DUANJUGOU_SOURCE, item.article_id, [tag]);
            if (modified) tagged += 1;
          }
          if (items.length < 100) break;
          await sleep(PAGE_DELAY_MS);
        }
        stats.tags_processed += 1;
        stats.dramas_tagged += tagged;
      } catch (error) {
        stats.failed_tags += 1;
        console.warn(
          `标签「${tag}」搜索回填失败:`,
          error instanceof Error ? error.message : String(error)
        );
      }
      await sleep(PAGE_DELAY_MS);
    }

    if (stats.tags_processed === 0 && stats.failed_tags > 0) {
      stats.failed = true;
      stats.error = "全部标签搜索失败";
    }
    return stats;
  } finally {
    await releaseShortDramaLease("scrape");
  }
}
