import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCloudDriveAvailability,
} from "@/lib/plugins/resource-host";
import {
  createCloudDriveTaskAdapter,
  listCloudDriveTaskPage,
  toLegacyKkpanPage,
} from "@/lib/pan/cloud-drive-task";
import type { CloudDriveResourceCandidate } from "@/lib/plugins/types";

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

function row(id: number, title = "示例影片", updatedAt = "2026-08-20T00:00:00Z") {
  return {
    id,
    file_name: `${title} (2026) 4K.mp4`,
    share_link: `https://pan.example.com/s/${id}`,
    share_code: "ab12",
    file_size: 1024,
    target_platform: "quark",
    updated_at: updatedAt,
  };
}

test("cloud-drive task adapter exposes provider-neutral search and scan evidence", async () => {
  const requests: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(new URL(typeof input === "string" ? input : input.toString()));
    return jsonResponse({ data: [row(101)], total: 1 });
  }) as typeof fetch;

  try {
    const adapter = createCloudDriveTaskAdapter({
      requestId: "cloud-drive-task-test",
      timeoutMs: 1_000,
    });
    const page = await adapter.search({
      title: "示例影片",
      content: {
        contentId: "550e8400-e29b-41d4-a716-446655440000",
        externalRefs: [],
      },
      cursor: "2",
      limit: 20,
    });

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.externalId, "101");
    assert.equal(page.items[0]?.sourceName, "示例影片 (2026) 4K.mp4");
    assert.equal(page.items[0]?.contentId, "550e8400-e29b-41d4-a716-446655440000");
    assert.equal(page.rawCount, 1);
    assert.deepEqual(page.rawIds, ["101"]);
    assert.equal(page.total, 1);
    assert.equal(requests[0]?.searchParams.get("page"), "2");
    assert.equal(requests[0]?.searchParams.get("limit"), "20");
  } finally {
    restoreFetch();
  }
});

test("cloud-drive task adapter preserves incremental cursor and updatedSince", async () => {
  const requests: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(new URL(typeof input === "string" ? input : input.toString()));
    return jsonResponse({
      data: [
        row(201, "旧资源", "2026-08-19T00:00:00Z"),
        row(202, "新资源", "2026-08-21T00:00:00Z"),
      ],
      total: 2,
    });
  }) as typeof fetch;

  try {
    const adapter = createCloudDriveTaskAdapter({ timeoutMs: 1_000 });
    const page = await adapter.incremental({
      cursor: "3",
      updatedSince: "2026-08-20T00:00:00Z",
      limit: 50,
    });

    assert.deepEqual(page.items.map((item) => item.externalId), ["202"]);
    // raw page evidence still describes the source page, even when the host
    // applies its updatedSince filter to the candidate list.
    assert.deepEqual(page.rawIds, ["201", "202"]);
    assert.equal(requests[0]?.searchParams.get("page"), "3");
    assert.equal(requests[0]?.searchParams.get("sort"), "latest");
  } finally {
    restoreFetch();
  }
});

test("resource host routes availability checks through the selected plugin", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return jsonResponse({ data: [row(301)], total: 1 });
  }) as typeof fetch;

  const resource: CloudDriveResourceCandidate = {
    kind: "cloud-drive",
    providerId: "kerkerker.kkpan-cloud-drive",
    externalId: "301",
    title: "示例影片 (2026)",
    platform: { platformId: "quark", brand: "quark" },
    url: "https://pan.example.com/s/301",
    availability: "unknown",
    provenance: {
      source: { providerId: "kerkerker.kkpan-cloud-drive" },
      pluginVersion: "1.0.0",
      fetchedAt: "2026-08-21T00:00:00Z",
    },
  };

  try {
    const checked = await checkCloudDriveAvailability(
      { resources: [resource] },
      { requestId: "availability-test", timeoutMs: 1_000 }
    );
    assert.equal(checked.length, 1);
    assert.equal(checked[0]?.availability, "available");
    assert.equal(checked[0]?.externalId, "301");
    assert.ok(calls >= 1);
  } finally {
    restoreFetch();
  }
});

test("legacy KKPAN bridge is strict about provider identity and IDs", async () => {
  const page = await (async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ data: [row(401)], total: 1 })) as typeof fetch;
    try {
      return await listCloudDriveTaskPage(1, 50, { timeoutMs: 1_000 });
    } finally {
      restoreFetch();
    }
  })();

  assert.equal(page.items[0]?.id, 401);
  assert.deepEqual(page.rawIds, [401]);

  const nonKkpan: CloudDriveResourceCandidate = {
    kind: "cloud-drive",
    providerId: "example.other-drive",
    externalId: "opaque-1",
    title: "资源",
    platform: { platformId: "quark" },
    url: "https://example.com/resource",
    availability: "available",
    provenance: {
      source: { providerId: "example.other-drive" },
      pluginVersion: "1.0.0",
      fetchedAt: "2026-08-21T00:00:00Z",
    },
  };
  assert.throws(
    () =>
      toLegacyKkpanPage({
        items: [nonKkpan],
        rawCount: 1,
        rawIds: ["opaque-1"],
        fingerprint: "opaque",
      }),
    /不能写入旧 KKPAN 同步字段/
  );
});
