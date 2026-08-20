import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.NEXT_PUBLIC_DOUBAN_API_URL = "https://iamyourfather.link0.me";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("content host invokes the active catalog plugin without an HTTP route hop", async () => {
  let requestedUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          subjects: [
            {
              id: "1292052",
              title: "肖申克的救赎",
              rate: "9.7",
              cover: "https://img.example/1292052.jpg",
              url: "https://movie.douban.com/subject/1292052/",
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, hasMore: false },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const { getContentCatalog } = await import("@/lib/plugins/content-host");
  const result = await getContentCatalog(
    { view: "category", key: "hot_movies", cursor: "1", limit: 20 },
    { runId: "catalog-run-1", timeoutMs: 1_000 }
  );

  assert.match(requestedUrl, /\/api\/v1\/category\?category=hot_movies&page=1&limit=20$/);
  assert.equal(result.items[0]?.externalRefs[0]?.externalId, "1292052");
  assert.equal(result.hasMore, false);
});

test("content host preserves cooperative cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const { getContentCatalog } = await import("@/lib/plugins/content-host");

  await assert.rejects(
    getContentCatalog(
      { view: "category", key: "hot_movies" },
      { signal: controller.signal }
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "EXECUTION_CANCELLED"
  );
});
