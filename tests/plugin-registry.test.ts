import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { GET as getPlugins } from "@/app/api/plugins/route";
import { pluginRegistry } from "@/lib/plugins";
import { createPluginRegistry } from "@/lib/plugins/registry";
import { PluginError } from "@/lib/plugins/errors";
import type { Plugin } from "@/lib/plugins/types";

function authenticatedRequest(url: string): NextRequest {
  const secret = "plugin-registry-test-secret";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(url, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

test("static registry contains the trusted built-in adapters", () => {
  const descriptors = pluginRegistry.list();
  assert.deepEqual(
    descriptors.map((plugin) => plugin.id),
    [
      "kerkerker.douban-content",
      "kerkerker.kkpan-cloud-drive",
      "kerkerker.tmdb-content",
    ]
  );
  assert.ok(
    descriptors.find((plugin) => plugin.id === "kerkerker.douban-content")?.capabilities.some(
      (capability) => capability.id === "content.catalog"
    )
  );
  assert.ok(
    descriptors.find((plugin) => plugin.id === "kerkerker.kkpan-cloud-drive")?.capabilities.some(
      (capability) => capability.id === "resource.cloud-drive"
    )
  );
  assert.ok(
    descriptors.find((plugin) => plugin.id === "kerkerker.tmdb-content")?.capabilities.some(
      (capability) => capability.id === "content.catalog"
    )
  );
});

test("plugin metadata endpoint requires admin auth", async () => {
  const anonymous = await getPlugins(new NextRequest("http://localhost/api/plugins"));
  assert.equal(anonymous.status, 401);

  const response = await getPlugins(authenticatedRequest("http://localhost/api/plugins?capability=resource.cloud-drive"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.plugins.length, 1);
  assert.equal(body.data.plugins[0].id, "kerkerker.kkpan-cloud-drive");
  assert.equal("secrets" in body.data.plugins[0], false);
});

test("plugin metadata endpoint rejects unknown capabilities", async () => {
  const response = await getPlugins(authenticatedRequest("http://localhost/api/plugins?capability=provider.secret"));
  assert.equal(response.status, 400);
});

test("plugin metadata endpoint can resolve a validated deployment profile", async () => {
  const response = await getPlugins(
    authenticatedRequest("http://localhost/api/plugins?profile=cn-default&capability=content.detail")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.profiles[0].id, "cn-default");
  assert.deepEqual(
    body.data.plugins.map((plugin: { id: string }) => plugin.id),
    ["kerkerker.douban-content"]
  );
});

test("registry rejects duplicate IDs and missing declared implementations", () => {
  const registered = pluginRegistry.get("kerkerker.douban-content");
  assert.ok(registered);
  assert.throws(
    () => createPluginRegistry([registered, registered]),
    (error: unknown) => error instanceof PluginError && error.code === "INVALID_MANIFEST"
  );

  const missingImplementation: Plugin = {
    ...registered,
    manifest: {
      ...registered.manifest,
      id: "example.missing-implementation",
      capabilities: [{ id: "content.detail", version: "1.0.0" }],
    },
    capabilities: {},
  };
  assert.throws(
    () => createPluginRegistry([missingImplementation]),
    (error: unknown) => error instanceof PluginError && error.code === "UNSUPPORTED_CAPABILITY"
  );
});
