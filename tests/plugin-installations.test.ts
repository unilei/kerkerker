import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  createPluginInstallationsRouteHandlers,
} from "@/app/api/plugins/installations/route";
import {
  InMemoryPluginInstallationStore,
  requireInstalled,
  requireUsable,
} from "@/lib/plugins/installation";
import { pluginRegistry } from "@/lib/plugins/builtin";
import { PluginError } from "@/lib/plugins/errors";

const PLUGIN_ID = "kerkerker.douban-content";

function request(
  url: string,
  init: ConstructorParameters<typeof NextRequest>[1] = {}
): NextRequest {
  const secret = "plugin-installation-test-secret";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  const headers = new Headers(init.headers);
  headers.set("cookie", `${SESSION_COOKIE_NAME}=${token}`);
  return new NextRequest(url, { ...init, headers });
}

test("installation metadata requires admin auth and defaults static plugins to available", async () => {
  const store = new InMemoryPluginInstallationStore();
  const handlers = createPluginInstallationsRouteHandlers({
    listPlugins: () => pluginRegistry.list(),
    getStore: async () => store,
    writeAudit: async () => undefined,
  });

  const anonymous = await handlers.GET(new NextRequest("http://localhost/api/plugins/installations"));
  assert.equal(anonymous.status, 401);

  const response = await handlers.GET(
    request("http://localhost/api/plugins/installations")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data.statuses, ["available", "installed", "enabled", "disabled", "failed"]);
  assert.ok(body.data.plugins.length >= 3);
  assert.ok(body.data.plugins.every((plugin: { installation: { status: string } }) => plugin.installation.status === "available"));
});

test("installation API changes lifecycle without deleting plugin data", async () => {
  const store = new InMemoryPluginInstallationStore();
  const auditActions: string[] = [];
  const handlers = createPluginInstallationsRouteHandlers({
    listPlugins: () => pluginRegistry.list(),
    getStore: async () => store,
    writeAudit: async (input) => {
      auditActions.push(input.action);
    },
  });

  const mutate = (action: string) =>
    handlers.POST(
      request("http://localhost/api/plugins/installations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, plugin_id: PLUGIN_ID }),
      })
    );

  assert.equal((await mutate("enable")).status, 409);
  assert.equal((await mutate("install")).status, 200);
  assert.equal((await mutate("enable")).status, 200);
  assert.equal((await mutate("disable")).status, 200);
  assert.equal((await mutate("uninstall")).status, 200);
  const record = await store.get(PLUGIN_ID);
  assert.equal(record?.status, "available");
  assert.ok(record?.installedAt);
  assert.ok(record?.uninstalledAt);
  assert.deepEqual(auditActions, [
    "plugin.installation.install",
    "plugin.installation.enable",
    "plugin.installation.disable",
    "plugin.installation.uninstall",
  ]);
});

test("installation API rejects unknown plugins and malformed actions", async () => {
  const handlers = createPluginInstallationsRouteHandlers({
    listPlugins: () => pluginRegistry.list(),
    getStore: async () => new InMemoryPluginInstallationStore(),
    writeAudit: async () => undefined,
  });
  const unknown = await handlers.POST(
    request("http://localhost/api/plugins/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "install", plugin_id: "example.not-registered" }),
    })
  );
  assert.equal(unknown.status, 400);
  const malformed = await handlers.POST(
    request("http://localhost/api/plugins/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "execute", plugin_id: PLUGIN_ID }),
    })
  );
  assert.equal(malformed.status, 400);
});

test("runtime installation gates fail closed until explicitly enabled", async () => {
  const store = new InMemoryPluginInstallationStore();
  await assert.rejects(
    () => requireInstalled(PLUGIN_ID, { store }),
    (error: unknown) => error instanceof PluginError && error.code === "CAPABILITY_UNAVAILABLE"
  );

  await store.transition(PLUGIN_ID, {
    status: "installed",
    pluginVersion: pluginRegistry.require(PLUGIN_ID).manifest.version,
  });
  assert.equal((await requireInstalled(PLUGIN_ID, { store })).status, "installed");
  await assert.rejects(
    () => requireUsable(PLUGIN_ID, { store }),
    (error: unknown) => error instanceof PluginError && error.code === "CAPABILITY_UNAVAILABLE"
  );

  await store.transition(PLUGIN_ID, {
    status: "enabled",
    pluginVersion: pluginRegistry.require(PLUGIN_ID).manifest.version,
  });
  assert.equal((await requireUsable(PLUGIN_ID, { store })).status, "enabled");
});

