import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpImageMirrorObjectStore,
  ImageMirrorService,
  InMemoryImageMirrorRepository,
  imageMirrorIdempotencyKey,
  imageMirrorObjectKey,
  normalizeImageMirrorInput,
  type ImageMirrorFetcher,
  type ImageMirrorInput,
  type ImageMirrorObject,
} from "@/lib/plugins/image-mirror";

const INPUT: ImageMirrorInput = {
  contentId: "550e8400-e29b-41d4-a716-446655440000",
  providerId: "kerkerker.douban-content",
  externalId: "1292052",
  purpose: "poster",
  originalUrl: "https://img.example.test/poster.jpg",
  width: 300,
  height: 450,
  mimeType: "image/jpeg",
};

function createService(options: {
  fetcher?: ImageMirrorFetcher;
  put?: (object: ImageMirrorObject) => Promise<{ mirrorUrl: string }>;
} = {}) {
  const repository = new InMemoryImageMirrorRepository();
  const uploaded: ImageMirrorObject[] = [];
  const objectStore = {
    async put(object: ImageMirrorObject) {
      uploaded.push(object);
      return options.put
        ? options.put(object)
        : { mirrorUrl: `https://cdn.example.test/${object.key}` };
    },
  };
  const fetcher = options.fetcher || {
    async fetch() {
      return {
        body: new Uint8Array([1, 2, 3]),
        contentType: "image/jpeg",
        width: 320,
        height: 480,
      };
    },
  };
  return {
    repository,
    uploaded,
    service: new ImageMirrorService({
      repository,
      objectStore,
      fetcher,
      assertUrl: async (url) => new URL(url),
    }),
  };
}

test("镜像成功后按 content/provider/external/purpose/url 幂等", async () => {
  let fetchCount = 0;
  const { service, uploaded } = createService({
    fetcher: {
      async fetch() {
        fetchCount += 1;
        return { body: new Uint8Array([1, 2]), contentType: "image/jpeg" };
      },
    },
  });

  const first = await service.mirror(INPUT);
  const second = await service.mirror({ ...INPUT });

  assert.equal(first.status, "mirrored");
  assert.equal(second.status, "mirrored");
  assert.equal(first.idempotencyKey, imageMirrorIdempotencyKey(INPUT));
  assert.match(first.objectKey, /^image-mirrors\/kerkerker\.douban-content\/[0-9a-f]{64}\.jpg$/);
  assert.equal(first.objectKey, imageMirrorObjectKey(INPUT));
  assert.equal(first.mirrorUrl, `https://cdn.example.test/${first.objectKey}`);
  assert.equal(first.width, 300);
  assert.equal(first.height, 450);
  assert.equal(fetchCount, 1);
  assert.equal(uploaded.length, 1);
  assert.deepEqual([...uploaded[0].body], [1, 2]);
});

test("失败记录可重试，也可由调用方关闭失败重试", async () => {
  let fetchCount = 0;
  const { service } = createService({
    fetcher: {
      async fetch() {
        fetchCount += 1;
        if (fetchCount === 1) throw new Error("upstream unavailable");
        return { body: new Uint8Array([8]), contentType: "image/jpeg" };
      },
    },
  });

  const failed = await service.mirror(INPUT);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.message, "upstream unavailable");

  const retried = await service.mirror(INPUT);
  assert.equal(retried.status, "mirrored");
  assert.equal(fetchCount, 2);

  const alwaysFailing = createService({
    fetcher: {
      async fetch() {
        throw new Error("still unavailable");
      },
    },
  });
  const failedAgain = await alwaysFailing.service.mirror({
    ...INPUT,
    externalId: "1292053",
  });
  const skipped = await alwaysFailing.service.mirror(
    { ...INPUT, externalId: "1292053" },
    { retryFailed: false }
  );
  assert.equal(failedAgain.status, "failed");
  assert.equal(skipped.status, "failed");
});

test("force 可以重新镜像 invalidated 记录，普通请求保持失效状态", async () => {
  let fetchCount = 0;
  const { service } = createService({
    fetcher: {
      async fetch() {
        fetchCount += 1;
        return { body: new Uint8Array([7]), contentType: "image/png" };
      },
    },
  });
  const mirrored = await service.mirror(INPUT);
  const invalidated = await service.invalidate(mirrored.idempotencyKey, "来源下架");
  assert.equal(invalidated?.status, "invalidated");

  const stillInvalidated = await service.mirror(INPUT);
  assert.equal(stillInvalidated.status, "invalidated");
  assert.equal(fetchCount, 1);

  const remirrored = await service.mirror(INPUT, { force: true });
  assert.equal(remirrored.status, "mirrored");
  assert.equal(remirrored.error, undefined);
  assert.equal(remirrored.invalidatedAt, undefined);
  assert.equal(fetchCount, 2);
});

test("输入校验拒绝非 UUID content_id、带凭据原图和非图片 MIME", () => {
  assert.throws(
    () => normalizeImageMirrorInput({ ...INPUT, contentId: "douban:1292052" }),
    /contentId 格式无效/
  );
  assert.throws(
    () => normalizeImageMirrorInput({ ...INPUT, originalUrl: "https://user:pass@img.example.test/a.jpg" }),
    /originalUrl URL 格式无效/
  );
  assert.throws(
    () => normalizeImageMirrorInput({ ...INPUT, mimeType: "text/html" }),
    /mimeType 必须是 image\/*/
  );
});

test("HTTP Worker object store 使用命名空间 key、Bearer token 与缓存策略", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const objectStore = createHttpImageMirrorObjectStore({
    uploadApiUrl: "https://upload.example.test/objects/",
    publicBaseUrl: "https://cdn.example.test/assets/",
    token: "secret-token",
    fetch: async (url, init) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(null, { status: 201 });
    },
  });

  const result = await objectStore.put({
    key: "image-mirrors/provider/a b.jpg",
    body: new Uint8Array([1, 2]),
    contentType: "image/jpeg",
    cacheControl: "public, max-age=60",
  });

  assert.equal(requestedUrl, "https://upload.example.test/objects/image-mirrors/provider/a%20b.jpg");
  assert.equal(result.mirrorUrl, "https://cdn.example.test/assets/image-mirrors/provider/a%20b.jpg");
  assert.equal(requestedInit?.method, "PUT");
  assert.equal((requestedInit?.headers as Record<string, string>).Authorization, "Bearer secret-token");
  assert.equal((requestedInit?.headers as Record<string, string>)["Content-Type"], "image/jpeg");
  assert.equal((requestedInit?.headers as Record<string, string>)["Cache-Control"], "public, max-age=60");
  assert.deepEqual([...new Uint8Array(await new Response(requestedInit?.body).arrayBuffer())], [1, 2]);
});
