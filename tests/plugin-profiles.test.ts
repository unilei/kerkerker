import assert from "node:assert/strict";
import test from "node:test";

import {
  CN_DEFAULT_PROFILE_ID,
  cnDefaultPluginProfile,
  pluginProfileRegistry,
} from "@/lib/plugins/builtin-profiles";
import { PluginError } from "@/lib/plugins/errors";
import { pluginRegistry } from "@/lib/plugins/builtin";
import { PluginRegistry } from "@/lib/plugins/registry";
import {
  createPluginProfileRegistry,
  type PluginProfile,
} from "@/lib/plugins/profiles";

function profile(overrides: Partial<PluginProfile> = {}): PluginProfile {
  return {
    id: "test-profile",
    locale: "zh-CN",
    region: "CN",
    capabilities: {
      "content.detail": ["kerkerker.douban-content"],
    },
    ...overrides,
  };
}

test("cn-default resolves plugins in declared capability order", () => {
  const configured = pluginProfileRegistry.require(CN_DEFAULT_PROFILE_ID);
  assert.equal(configured.locale, "zh-CN");
  assert.equal(configured.region, "CN");
  assert.deepEqual(
    pluginProfileRegistry
      .resolve(CN_DEFAULT_PROFILE_ID, "content.detail")
      .map((plugin) => plugin.manifest.id),
    ["kerkerker.douban-content"]
  );
  assert.deepEqual(
    pluginProfileRegistry.getPluginIds(
      CN_DEFAULT_PROFILE_ID,
      "resource.cloud-drive"
    ),
    ["kerkerker.kkpan-cloud-drive"]
  );
});

test("profile startup validation rejects an unknown plugin", () => {
  assert.throws(
    () =>
      createPluginProfileRegistry(pluginRegistry, [
        profile({
          capabilities: { "content.detail": ["missing.content-plugin"] },
        }),
      ]),
    (error: unknown) =>
      error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );
});

test("profile startup validation rejects a capability the plugin did not declare", () => {
  assert.throws(
    () =>
      createPluginProfileRegistry(pluginRegistry, [
        profile({
          capabilities: {
            "content.detail": ["kerkerker.kkpan-cloud-drive"],
          },
        }),
      ]),
    (error: unknown) =>
      error instanceof PluginError && error.code === "UNSUPPORTED_CAPABILITY"
  );
});

test("profile registry rejects duplicate profile IDs and duplicate bindings", () => {
  assert.throws(
    () =>
      createPluginProfileRegistry(pluginRegistry, [
        cnDefaultPluginProfile,
        cnDefaultPluginProfile,
      ]),
    (error: unknown) =>
      error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );

  assert.throws(
    () =>
      createPluginProfileRegistry(pluginRegistry, [
        profile({
          capabilities: {
            "content.detail": [
              "kerkerker.douban-content",
              "kerkerker.douban-content",
            ],
          },
        }),
      ]),
    (error: unknown) =>
      error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );
});

test("profile locale must be supported by every bound plugin", () => {
  assert.throws(
    () =>
      createPluginProfileRegistry(pluginRegistry, [
        profile({ id: "en-default", locale: "en-US" }),
      ]),
    (error: unknown) =>
      error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );
});

test("profile accepts a language-only plugin locale with a GLOBAL plugin scope", () => {
  const languagePlugin = pluginRegistry.get("kerkerker.douban-content");
  assert.ok(languagePlugin);
  const languagePluginCopy = {
    ...languagePlugin.manifest,
    id: "example.global-content",
    locales: ["zh"],
    compliance: { ...languagePlugin.manifest.compliance, regions: ["GLOBAL"] },
  };
  const registry = createPluginProfileRegistry(new PluginRegistry([{
    ...languagePlugin,
    manifest: languagePluginCopy,
  }]), [
    profile({
      id: "global-zh",
      locale: "zh-CN",
      region: "CN",
      capabilities: { "content.detail": ["example.global-content"] },
    }),
  ]);
  assert.equal(registry.get("global-zh")?.region, "CN");
});

test("profile rejects GLOBAL as a runtime region", () => {
  assert.throws(
    () => createPluginProfileRegistry(pluginRegistry, [profile({ region: "GLOBAL" })]),
    (error: unknown) => error instanceof PluginError && error.code === "CONFIGURATION_ERROR"
  );
});

test("unbound capabilities fail explicitly instead of selecting any plugin", () => {
  assert.throws(
    () => pluginProfileRegistry.resolve(CN_DEFAULT_PROFILE_ID, "resource.playback"),
    (error: unknown) =>
      error instanceof PluginError && error.code === "CAPABILITY_UNAVAILABLE"
  );
});
