import { absoluteUrl } from "@/lib/seo";

/**
 * 新发布短剧的搜索引擎主动推送（百度普通收录 API + IndexNow）。
 *
 * 用法：转存流水线里每部剧成功落库（status=done 且有自有链接）时
 * `queuePublishedDramaUrl(id)` 入缓冲，一轮任务结束时
 * `flushQueuedDramaUrls()` 批量发送。两个通道都是尽力而为：
 * 未配 token/key 直接跳过；网络失败只记日志，绝不影响主流程。
 *
 * env：
 *   BAIDU_PUSH_TOKEN  百度搜索资源平台「普通收录」推送接口 token
 *   INDEXNOW_KEY      IndexNow 密钥（8-128 位 hex；公开校验文件见
 *                     /indexnow-key.txt 路由）
 */

const BAIDU_PUSH_ENDPOINT = "http://data.zz.baidu.com/urls";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

let pendingDramaIds: string[] = [];

/** 入缓冲（去重）；不发送，等任务收尾统一 flush */
export function queuePublishedDramaUrl(dramaId: string): void {
  if (dramaId && !pendingDramaIds.includes(dramaId)) {
    pendingDramaIds.push(dramaId);
  }
}

function dramaUrl(dramaId: string): string {
  return absoluteUrl(`/drama/${dramaId}`);
}

/** 百度普通收录 API：POST 纯文本（每行一个 URL），单次 ≤ 2000 条 */
async function pushBaidu(urls: string[]): Promise<void> {
  const token = process.env.BAIDU_PUSH_TOKEN?.trim();
  if (!token || urls.length === 0) return;

  const endpoint = new URL(BAIDU_PUSH_ENDPOINT);
  endpoint.searchParams.set("site", new URL(absoluteUrl("/")).host);
  endpoint.searchParams.set("token", token);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: urls.join("\n"),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`百度推送 HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    success?: number;
    remain?: number;
    message?: string;
  };
  console.log(
    `[seo-push] 百度推送成功 ${payload.success ?? 0}/${urls.length}，剩余配额 ${payload.remain ?? "?"}`
  );
}

/** IndexNow（Bing/Yandex 等共用入口）：单次 ≤ 10k 条 */
async function pushIndexNow(urls: string[]): Promise<void> {
  const key = process.env.INDEXNOW_KEY?.trim();
  if (!key || urls.length === 0) return;

  const siteUrl = absoluteUrl("/");
  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(siteUrl).host,
      key,
      keyLocation: absoluteUrl("/indexnow-key.txt"),
      urlList: urls,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  // IndexNow 200/202 都算受理成功
  if (!response.ok && response.status !== 202) {
    throw new Error(`IndexNow HTTP ${response.status}`);
  }
  console.log(`[seo-push] IndexNow 已提交 ${urls.length} 条 URL`);
}

/**
 * 发送缓冲中的 URL 并清空。失败仅打日志，缓冲一并清掉（下一轮任务
 * 会重新入队，避免无效重试堆积）。
 */
export async function flushQueuedDramaUrls(): Promise<void> {
  const ids = pendingDramaIds;
  pendingDramaIds = [];
  if (ids.length === 0) return;
  const urls = ids.map(dramaUrl);

  try {
    await pushBaidu(urls);
  } catch (error) {
    console.warn(
      "[seo-push] 百度推送失败（不影响任务）:",
      error instanceof Error ? error.message : String(error)
    );
  }
  try {
    await pushIndexNow(urls);
  } catch (error) {
    console.warn(
      "[seo-push] IndexNow 推送失败（不影响任务）:",
      error instanceof Error ? error.message : String(error)
    );
  }
}
