import assert from "node:assert/strict";
import test from "node:test";
import { createPluginRegistry } from "@/lib/plugins/registry";
import { invokePlugin } from "@/lib/plugins/runtime";
import { PluginError } from "@/lib/plugins/errors";
import type { Plugin, PluginContext } from "@/lib/plugins/types";

const remotePlugin: Plugin = {
  manifest: {
    id: "example.remote",
    name: "Example remote",
    version: "1.0.0",
    contractVersion: "1.0.0",
    runtime: { mode: "remote", entry: "https://1.1.1.1" },
    capabilities: [{ id: "content.detail", version: "1.0.0" }],
    locales: ["zh-CN"],
    config: { version: "1.0", fields: [] },
    compliance: {
      legalBasis: "test",
      contentScope: "test",
      regions: ["CN"],
      dataClassification: "public",
    },
    permissions: { networkHosts: ["1.1.1.1"], secrets: [], storage: "none" },
  },
  capabilities: {},
};

function context(): PluginContext {
  return {
    runtime: "server",
    requestId: "sidecar-test",
    profile: "test",
    locale: "zh-CN",
    region: "CN",
    deadline: "2026-08-21T00:00:00.000Z",
    signal: new AbortController().signal,
    config: { internal: "not-sent" },
    secrets: { get: () => "not-sent" },
    storage: { async get() { return undefined; }, async set() {}, async delete() {} },
    logger: { info() {}, warn() {}, error() {} },
  };
}

test("remote manifests do not require local implementations and use the fixed sidecar envelope", async () => {
  const registry = createPluginRegistry([remotePlugin]);
  const originalFetch = globalThis.fetch;
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url, init) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await invokePlugin<{ ok: boolean }>({
      registry,
      pluginId: remotePlugin.manifest.id,
      capability: "content.detail",
      operation: "detail",
      context: context(),
      request: { value: "request" },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(captured?.capability, "content.detail");
    assert.equal(captured?.operation, "detail");
    assert.equal((captured?.context as Record<string, unknown>).requestId, "sidecar-test");
    assert.equal("config" in (captured?.context as Record<string, unknown>), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote sidecar rejects non-json or oversized responses", async () => {
  const registry = createPluginRegistry([remotePlugin]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      () => invokePlugin({
        registry,
        pluginId: remotePlugin.manifest.id,
        capability: "content.detail",
        operation: "detail",
        context: context(),
        request: {},
      }),
      (error: unknown) => error instanceof PluginError && error.code === "UPSTREAM_ERROR"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote sidecar rejects an entry outside the declared network allowlist", async () => {
  const registry = createPluginRegistry([
    {
      ...remotePlugin,
      manifest: {
        ...remotePlugin.manifest,
        permissions: { ...remotePlugin.manifest.permissions, networkHosts: [] },
      },
    },
  ]);
  await assert.rejects(
    () => invokePlugin({
      registry,
      pluginId: remotePlugin.manifest.id,
      capability: "content.detail",
      operation: "detail",
      context: context(),
      request: {},
    }),
    (error: unknown) => error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );
});
