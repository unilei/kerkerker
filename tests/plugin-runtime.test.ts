import assert from "node:assert/strict";
import test from "node:test";

import { PluginError } from "@/lib/plugins/errors";
import { createPluginRegistry } from "@/lib/plugins/registry";
import { invokePlugin } from "@/lib/plugins/runtime";
import { invokeProfilePlugin } from "@/lib/plugins/runtime";
import { createPluginContext } from "@/lib/plugins/context";
import { createPluginProfileRegistry } from "@/lib/plugins/profiles";
import type { Plugin, PluginContext } from "@/lib/plugins/types";

function context(signal: AbortSignal): PluginContext {
  return {
    runtime: "server",
    requestId: "runtime-test",
    profile: "test",
    locale: "zh-CN",
    region: "CN",
    deadline: "2026-08-19T00:00:00.000Z",
    signal,
    config: {},
    secrets: { get: () => undefined },
    storage: {
      async get() { return undefined; },
      async set() {},
      async delete() {},
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

const plugin: Plugin = {
  manifest: {
    id: "example.runtime",
    name: "Example runtime",
    version: "1.0.0",
    contractVersion: "1.0.0",
    runtime: { mode: "built-in", entry: "./example-runtime" },
    capabilities: [{ id: "content.detail", version: "1.0.0" }],
    locales: ["zh-CN"],
    config: { version: "1.0", fields: [] },
    compliance: {
      legalBasis: "test",
      contentScope: "test",
      regions: ["CN"],
      dataClassification: "public",
    },
    permissions: { networkHosts: [], secrets: [], storage: "none" },
  },
  capabilities: {
    "content.detail": {
      async detail(_context, request) {
        return {
          type: "movie",
          externalRefs: [],
          titles: [{ locale: "zh-CN", value: String((request as { value?: string }).value || "ok") }],
          details: {},
          provenance: {
            source: { providerId: "example.runtime" },
            pluginVersion: "1.0.0",
            fetchedAt: "2026-08-19T00:00:00.000Z",
          },
        };
      },
    },
  },
};

const registry = createPluginRegistry([plugin]);
const profiles = createPluginProfileRegistry(registry, [{
  id: "test",
  locale: "zh-CN",
  region: "CN",
  capabilities: { "content.detail": ["example.runtime"] },
}]);

test("invokes a declared operation through the host boundary", async () => {
  const result = await invokePlugin<{ titles: readonly { value: string }[] }>({
    registry,
    pluginId: "example.runtime",
    capability: "content.detail",
    operation: "detail",
    context: context(new AbortController().signal),
    request: { value: "resolved" },
  });
  assert.equal(result.titles[0]?.value, "resolved");
});

test("rejects a cancelled invocation before calling the plugin", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => invokePlugin({
      registry,
      pluginId: "example.runtime",
      capability: "content.detail",
      operation: "detail",
      context: context(controller.signal),
      request: {},
    }),
    (error: unknown) => error instanceof PluginError && error.code === "EXECUTION_CANCELLED"
  );
});

test("rejects undeclared operations and unknown plugins", async () => {
  await assert.rejects(
    () => invokePlugin({
      registry,
      pluginId: "example.runtime",
      capability: "content.detail",
      operation: "search",
      context: context(new AbortController().signal),
      request: {},
    }),
    (error: unknown) => error instanceof PluginError && error.code === "UNSUPPORTED_CAPABILITY"
  );
  await assert.rejects(
    () => invokePlugin({
      registry,
      pluginId: "missing.runtime",
      capability: "content.detail",
      operation: "detail",
      context: context(new AbortController().signal),
      request: {},
    }),
    (error: unknown) => error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );
});

test("profile invocation resolves the configured plugin and validates context", async () => {
  const result = await invokeProfilePlugin<{ titles: readonly { value: string }[] }>({
    profileRegistry: profiles,
    profileId: "test",
    capability: "content.detail",
    operation: "detail",
    context: context(new AbortController().signal),
    request: { value: "profile-resolved" },
  });
  assert.equal(result.titles[0]?.value, "profile-resolved");

  await assert.rejects(
    () => invokeProfilePlugin({
      profileRegistry: profiles,
      profileId: "test",
      capability: "content.detail",
      operation: "detail",
      context: { ...context(new AbortController().signal), locale: "en-US" },
      request: {},
    }),
    (error: unknown) => error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );
});

test("host context derives locale and region from the selected profile", () => {
  const context = createPluginContext({
    profileId: "cn-default",
    requestId: "context-test",
    timeoutMs: 1000,
  });
  assert.equal(context.profile, "cn-default");
  assert.equal(context.locale, "zh-CN");
  assert.equal(context.region, "CN");
  assert.equal(context.requestId, "context-test");
  assert.ok(Date.parse(context.deadline) > Date.now());
  assert.equal(context.secrets.get("missing"), undefined);
});

test("host context combines caller cancellation with its timeout signal", () => {
  const controller = new AbortController();
  const context = createPluginContext({
    profileId: "cn-default",
    signal: controller.signal,
    timeoutMs: 1000,
  });
  assert.equal(context.signal.aborted, false);
  controller.abort();
  assert.equal(context.signal.aborted, true);
});
