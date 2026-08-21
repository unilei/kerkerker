import assert from "node:assert/strict";
import test from "node:test";
import { createPluginRegistry } from "@/lib/plugins/registry";
import { invokePlugin } from "@/lib/plugins/runtime";
import { invokeRemoteSidecar } from "@/lib/plugins/sidecar";
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

function context(secretValues: Record<string, string | undefined> = {}): PluginContext {
  return {
    runtime: "server",
    requestId: "sidecar-test",
    profile: "test",
    locale: "zh-CN",
    region: "CN",
    deadline: "2026-08-21T00:00:00.000Z",
    signal: new AbortController().signal,
    config: { internal: "not-sent" },
    secrets: { get: (name) => secretValues[name] },
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

test("remote sidecar performs optional health/version negotiation and sends only host-provided auth", async () => {
  const plugin: Plugin = {
    ...remotePlugin,
    manifest: {
      ...remotePlugin.manifest,
      runtime: {
        ...remotePlugin.manifest.runtime,
        protocolVersions: ["1.0.0"],
        health: { path: "/healthz", timeoutMs: 500 },
        auth: { type: "bearer", secret: "remote.token" },
      },
      permissions: {
        ...remotePlugin.manifest.permissions,
        secrets: ["remote.token"],
      },
    },
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const headers = { "x-kerkerker-contract-version": "1.0.0" };
    if (String(url).endsWith("/healthz")) return new Response("{}", { status: 200, headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  };

  const result = await invokeRemoteSidecar<{ ok: boolean }>({
    manifest: plugin.manifest,
    capability: "content.detail",
    operation: "detail",
    context: context({ "remote.token": "host-only-token" }),
    request: { value: "request" },
    fetcher,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://1.1.1.1/healthz");
  assert.equal(calls[1]?.url, "https://1.1.1.1/v1/invoke");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer host-only-token");
  assert.equal((calls[1]?.init?.headers as Record<string, string>).authorization, "Bearer host-only-token");
  assert.equal((calls[1]?.init?.headers as Record<string, string>)["x-kerkerker-contract-versions"], "1.0.0");
  const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
  assert.equal(JSON.stringify(body).includes("host-only-token"), false);
});

test("remote sidecar fails closed when auth secret is not available to the host", async () => {
  const plugin: Plugin = {
    ...remotePlugin,
    manifest: {
      ...remotePlugin.manifest,
      runtime: {
        ...remotePlugin.manifest.runtime,
        auth: { type: "bearer", secret: "remote.token" },
      },
      permissions: {
        ...remotePlugin.manifest.permissions,
        secrets: ["remote.token"],
      },
    },
  };
  await assert.rejects(
    () => invokeRemoteSidecar({
      manifest: plugin.manifest,
      capability: "content.detail",
      operation: "detail",
      context: context({ "remote.token": undefined }),
      request: {},
    }),
    (error: unknown) => error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );
});

test("remote sidecar rejects an incompatible negotiated protocol version", async () => {
  const plugin: Plugin = {
    ...remotePlugin,
    manifest: {
      ...remotePlugin.manifest,
      runtime: {
        ...remotePlugin.manifest.runtime,
        protocolVersions: ["1.0.0"],
      },
    },
  };
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "x-kerkerker-contract-version": "2.0.0" },
  });
  await assert.rejects(
    () => invokeRemoteSidecar({
      manifest: plugin.manifest,
      capability: "content.detail",
      operation: "detail",
      context: context(),
      request: {},
      fetcher,
    }),
    (error: unknown) => error instanceof PluginError && error.code === "UPSTREAM_ERROR" && error.path === "x-kerkerker-contract-version"
  );
});

test("remote sidecar stops before invoke when its health endpoint is unavailable", async () => {
  const plugin: Plugin = {
    ...remotePlugin,
    manifest: {
      ...remotePlugin.manifest,
      runtime: {
        ...remotePlugin.manifest.runtime,
        health: { path: "/healthz", timeoutMs: 500 },
      },
    },
  };
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    urls.push(String(url));
    return new Response("unhealthy", { status: 503 });
  };
  await assert.rejects(
    () => invokeRemoteSidecar({
      manifest: plugin.manifest,
      capability: "content.detail",
      operation: "detail",
      context: context(),
      request: {},
      fetcher,
    }),
    (error: unknown) => error instanceof PluginError && error.code === "UPSTREAM_ERROR" && error.path === "runtime.health"
  );
  assert.deepEqual(urls, ["https://1.1.1.1/healthz"]);
});
