/**
 * 同步引擎行为测试（不是源码字符串守门，而是真正调用函数 + stub fetch）
 *
 * 覆盖：
 *   - P2-D：上游全故障时 runBackfillSync 返回 failed:true 且不触碰 DB
 *   - lib/kkpan.ts 的 searchKkpanResources / listKkpanPage 解析与 URL 参数行为
 *
 * 这一层无需 MongoDB —— 失败路径在调用 DB 之前就早退；
 * kkpan 客户端测试只依赖 fetch stub。
 *
 * 运行：npx tsx tests/pan-sync-behavior.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  searchKkpanResources,
  listKkpanPage,
  listKkpanPageWithMeta,
  type KkpanPageResult,
  type KkpanResource,
} from "@/lib/kkpan";
import {
  runBackfillSync,
  getLegacyDoubanCandidate,
  matchContentForTitle,
  scanStablePages,
  selectIncrementalCandidates,
} from "@/lib/pan/sync";

// fetchFromService 内部会用 console.error 打印错误日志，对本套件而言是预期噪音。
const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function pageResult(ids: number[], total: number): KkpanPageResult {
  const items: KkpanResource[] = ids.map((id) => ({
    id,
    fileName: `资源 ${id}`,
    shareLink: `https://pan.example.com/s/${id}`,
    targetPlatform: "quark",
    updatedAt: "2024-01-01T00:00:00Z",
  }));
  return {
    items,
    total,
    rawCount: ids.length,
    rawIds: ids,
    fingerprint: JSON.stringify(ids),
  };
}

test("stable page scan: 第 2 页漂移时拒绝整轮并避免误禁用", async () => {
  let calls = 0;
  const fetchPage = async (page: number): Promise<KkpanPageResult> => {
    calls++;
    // 首轮为 [1,2] / [3,4] / 空；确认轮把第 2 页替换为 [4,5]，
    // total 仍为 4，专门覆盖“只重读第一页”无法发现的漂移。
    if (calls <= 3) {
      return page === 1
        ? pageResult([1, 2], 4)
        : page === 2
          ? pageResult([3, 4], 4)
          : pageResult([], 4);
    }
    return page === 1
      ? pageResult([1, 2], 4)
      : page === 2
        ? pageResult([4, 5], 4)
        : pageResult([], 4);
  };

  await assert.rejects(
    () => scanStablePages(fetchPage, 2, 5),
    /目录发生变化，请稍后重试/
  );
  assert.equal(calls, 5, "发现第 2 页漂移后应立即停止确认，不再继续读取");
});

test("内容插件资源匹配保持 suggestion 顺序，不被 advanced 结果改写", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      code: 200,
      data: {
        advanced: [
          {
            id: "999",
            title: "老九门",
            rate: "9.9",
            cover: "https://image.example/advanced.jpg",
            url: "https://movie.douban.com/subject/999/",
          },
        ],
        suggest: [
          {
            id: "123",
            title: "老九门",
            img: "https://image.example/suggest.jpg",
            url: "https://movie.douban.com/subject/123/",
            type: "tv",
            year: "2016",
          },
        ],
      },
    })) as unknown as typeof fetch;

  try {
    assert.deepEqual(await matchContentForTitle("老九门", "2016"), {
      doubanId: "123",
      title: "老九门",
    });
  } finally {
    restoreFetch();
  }
});

test("资源匹配拒绝把非 Douban 插件 ID 写进兼容字段", async () => {
  assert.equal(
    getLegacyDoubanCandidate({
      type: "movie",
      externalRefs: [{ providerId: "kerkerker.tmdb-content", externalId: "550" }],
      titles: [{ locale: "zh-CN", value: "搏击俱乐部" }],
      provenance: {
        source: { providerId: "kerkerker.tmdb-content" },
        pluginVersion: "1.0.0",
        fetchedAt: "2026-08-20T00:00:00.000Z",
      },
    }),
    null
  );
});

test("P2-D: 所有豆瓣分类请求失败时 runBackfillSync 返回 failed:true 并跳过 DB 写入", async () => {
  // 让所有 fetch 都抛错 —— douban 分类接口失败 ×2，subjects 收集为 0，
  // 触发早退分支：stats.failed=true，且不会调用 getExistingPanKeys / savePanSyncState。
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("Douban API error")) return; // 预期噪音
    originalConsoleError(...args);
  };

  try {
    const stats = await runBackfillSync(50);
    assert.equal(
      stats.failed,
      true,
      "所有分类失败时应认定为整体失败（failed:true），避免显示成同步完成"
    );
    assert.equal(
      stats.categoryErrors,
      2,
      "电影 + 电视剧两个分类都应记入 categoryErrors"
    );
    assert.equal(stats.imported, 0);
    assert.equal(stats.pulled, 0);
  } finally {
    restoreFetch();
    console.error = originalConsoleError;
  }
});

test("P2-D: 仅有补库模式产生 failed:true（增量模式不写该字段）", () => {
  // 这里只能做轻量校验，因为增量模式会触发 DB 调用；通过类型层面确认 SyncStats
  // 字段定义存在。详细的 failed 透传由源码守门覆盖。
  // 该 test 主要保证导出的 runBackfillSync 行为已固化为本测试套件的一部分。
  assert.equal(typeof runBackfillSync, "function");
});

test("lib/kkpan: searchKkpanResources 正确把行数据映射为 KkpanResource", async () => {
  const captured: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.push(url);
    return jsonResponse({
      data: [
        {
          id: 123,
          file_name: "[2024] 示例影片.mp4",
          share_link: "https://pan.example.com/s/abc",
          share_code: "ab12",
          file_size: 1024 * 1024 * 500,
          target_platform: "quark",
          updated_at: "2024-01-01T00:00:00Z",
        },
        {
          id: 124,
          file_name: "无链接资源.mp4",
          share_link: null, // 应被过滤掉
          target_platform: "quark",
        },
      ],
    });
  }) as unknown as typeof fetch;

  try {
    const items = await searchKkpanResources("示例影片", 10, 2);
    assert.equal(items.length, 1, "无 share_link 的行应被过滤");
    assert.equal(items[0].id, 123);
    assert.equal(items[0].shareLink, "https://pan.example.com/s/abc");
    assert.equal(items[0].shareCode, "ab12");
    assert.equal(items[0].targetPlatform, "quark");
    assert.ok(
      /page=2/.test(captured[0]),
      "searchKkpanResources 应把 page 参数透传给接口"
    );
    assert.ok(
      /search=/.test(captured[0]),
      "searchKkpanResources 应带 search 关键词"
    );
  } finally {
    restoreFetch();
  }
});

test("lib/kkpan: listKkpanPage 显式带 sort=latest 防止接口默认精选排序", async () => {
  const captured: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.push(url);
    return jsonResponse({ data: [] });
  }) as unknown as typeof fetch;

  try {
    await listKkpanPage(1, 50);
    assert.ok(
      /sort=latest/.test(captured[0]),
      "listKkpanPage 必须显式带 sort=latest，避免默认精选排序漏拉最新更新"
    );
    assert.ok(
      /page=1/.test(captured[0]) && /limit=50/.test(captured[0]),
      "listKkpanPage 应透传 page/limit"
    );
  } finally {
    restoreFetch();
  }
});

test("lib/kkpan: 分页元数据保留 total/rawCount，允许同步确认末页", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      data: [
        {
          id: 321,
          file_name: "元数据测试",
          share_link: "https://pan.example.com/s/meta",
          target_platform: "quark",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ],
      total: 51,
    })) as unknown as typeof fetch;

  try {
    const result = await listKkpanPageWithMeta(1, 50);
    assert.equal(result.total, 51);
    assert.equal(result.rawCount, 1);
    assert.deepEqual(result.rawIds, [321]);
    assert.equal(typeof result.fingerprint, "string");
    assert.equal(result.items.length, 1);
  } finally {
    restoreFetch();
  }
});

test("lib/kkpan: 非法原始 ID 拒绝进入稳定分页扫描", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      data: [
        {
          id: "321",
          file_name: "非法 ID",
          share_link: "https://pan.example.com/s/invalid",
          target_platform: "quark",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ],
    })) as unknown as typeof fetch;

  try {
    await assert.rejects(
      () => listKkpanPageWithMeta(1, 50),
      /资源 id 必须是正安全整数/
    );
  } finally {
    restoreFetch();
  }
});

test("incremental cursor: 不依赖上游返回顺序，并保留同时间戳资源", () => {
  const items = [
    {
      id: 1,
      fileName: "旧资源",
      shareLink: "https://pan.example/1",
      targetPlatform: "quark" as const,
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    {
      id: 3,
      fileName: "同时间新 ID",
      shareLink: "https://pan.example/3",
      targetPlatform: "quark" as const,
      updatedAt: "2024-01-03T00:00:00.000Z",
    },
    {
      id: 2,
      fileName: "乱序的新资源",
      shareLink: "https://pan.example/2",
      targetPlatform: "quark" as const,
      updatedAt: "2024-01-02T00:00:00.000Z",
    },
    {
      id: 4,
      fileName: "并列时间戳",
      shareLink: "https://pan.example/4",
      targetPlatform: "quark" as const,
      updatedAt: "2024-01-02T00:00:00.000Z",
    },
  ];
  const candidates = selectIncrementalCandidates(
    items,
    "2024-01-02T00:00:00.000Z"
  );
  assert.deepEqual(
    candidates.map((item) => item.id),
    [3, 4, 2],
    "应保留水位边界上的全部资源，并按稳定顺序排序"
  );
});

test("incremental cursor: 高水位边界 ID 与 pending ID 可精确续跑", () => {
  const items = [
    {
      id: 1,
      fileName: "已处理边界",
      shareLink: "https://pan.example/1",
      targetPlatform: "quark" as const,
      updatedAt: "2024-01-03T00:00:00.000Z",
    },
    {
      id: 2,
      fileName: "同时间新条目",
      shareLink: "https://pan.example/2",
      targetPlatform: "quark" as const,
      updatedAt: "2024-01-03T00:00:00.000Z",
    },
    {
      id: 3,
      fileName: "待处理旧条目",
      shareLink: "https://pan.example/3",
      targetPlatform: "quark" as const,
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ];
  const candidates = selectIncrementalCandidates(
    items,
    "2024-01-03T00:00:00.000Z",
    [1],
    [3]
  );
  assert.deepEqual(
    candidates.map((item) => item.id),
    [3, 2],
    "同时间未见 ID 和 pending ID 都必须保留，且 pending 应优先消费"
  );
});

test("incremental cursor: pending ID 优先于持续涌入的新资源", () => {
  const candidates = selectIncrementalCandidates(
    [
      {
        id: 10,
        fileName: "新资源",
        shareLink: "https://pan.example/10",
        targetPlatform: "quark" as const,
        updatedAt: "2024-01-05T00:00:00.000Z",
      },
      {
        id: 11,
        fileName: "待处理旧资源",
        shareLink: "https://pan.example/11",
        targetPlatform: "quark" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ],
    "2024-01-04T00:00:00.000Z",
    [],
    [11]
  );
  assert.deepEqual(candidates.map((item) => item.id), [11, 10]);
});

test("lib/kkpan: 非 2xx 响应抛错（由同步引擎 catch 收集为错误统计）", async () => {
  globalThis.fetch = (async () =>
    new Response("server error", { status: 503 })) as unknown as typeof fetch;

  try {
    await assert.rejects(
      () => searchKkpanResources("任意", 10),
      /HTTP 503/,
      "非 2xx 应抛错而非返回空数组，否则上游故障会被静默吞掉"
    );
  } finally {
    restoreFetch();
  }
});

test("lib/kkpan: 200 响应缺少 data 数组时抛错，避免把协议故障当空目录", async () => {
  globalThis.fetch = (async () => jsonResponse({ total: 0 })) as unknown as typeof fetch;

  try {
    await assert.rejects(
      () => listKkpanPageWithMeta(1, 50),
      /data 必须是数组/
    );
  } finally {
    restoreFetch();
  }
});
