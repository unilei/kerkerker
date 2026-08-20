import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPluginManifest,
  getPluginManifestIssues,
  validatePluginManifest,
} from "@/lib/plugins/validation";
import {
  PLUGIN_CAPABILITIES,
  type CloudDriveSearchCapability,
  type ContentDetailCapability,
  type Plugin,
  type PluginManifestInput,
  type PluginContext,
} from "@/lib/plugins/types";
import { PluginError } from "@/lib/plugins/errors";

function manifest(overrides: Record<string, unknown> = {}): PluginManifestInput {
  return {
    id: "example.catalog",
    name: "Example catalog",
    version: "1.2.3",
    contractVersion: "1.0",
    runtime: { mode: "built-in", entry: "./plugins/example" },
    capabilities: [
      { id: "content.catalog", version: "1.0.0" },
      { id: "content.calendar", version: "1.0.0" },
      { id: "content.detail", version: "1.0.0" },
      { id: "content.search", version: "1.0.0" },
      {
        id: "resource.cloud-drive",
        version: "1.0.0",
        features: ["search", "incremental", "availability"],
      },
      { id: "resource.playback", version: "1.0.0" },
      { id: "interaction.danmu", version: "1.0.0" },
      { id: "asset.image", version: "1.0.0" },
      { id: "recommendation", version: "1.0.0" },
    ],
    locales: ["zh-CN", "en-US"],
    config: {
      version: "1.0",
      fields: [
        { key: "baseUrl", type: "url", required: true },
        { key: "token", type: "secret", secret: true },
      ],
    },
    compliance: {
      legalBasis: "operator-approved license",
      termsUrl: "https://example.com/terms",
      contentScope: "licensed catalog metadata",
      regions: ["CN", "US"],
      dataClassification: "licensed",
    },
    permissions: {
      networkHosts: ["api.example.com"],
      secrets: ["catalog.token"],
      storage: "namespaced",
    },
    ...overrides,
  };
}

test("validates the complete v1 manifest and all stable capability namespaces", () => {
  const value = manifest();

  assert.equal(validatePluginManifest(value), true);
  assert.deepEqual(
    getPluginManifestIssues(value),
    [],
    "a complete manifest must not produce validation issues"
  );
  assert.doesNotThrow(() => assertPluginManifest(value));
  assert.deepEqual(PLUGIN_CAPABILITIES, [
    "content.catalog",
    "content.calendar",
    "content.detail",
    "content.search",
    "resource.cloud-drive",
    "resource.playback",
    "interaction.danmu",
    "asset.image",
    "recommendation",
  ]);
});

test("rejects unknown, duplicate, and incomplete cloud-drive capabilities", () => {
  const unknown = manifest({
    capabilities: [{ id: "content.unknown", version: "1.0.0" }],
  });
  assert.equal(validatePluginManifest(unknown), false);
  assert.equal(getPluginManifestIssues(unknown)[0]?.code, "UNKNOWN_CAPABILITY");

  const duplicate = manifest({
    capabilities: [
      { id: "content.detail", version: "1.0.0" },
      { id: "content.detail", version: "1.0.0" },
    ],
  });
  assert.equal(validatePluginManifest(duplicate), false);
  assert.ok(getPluginManifestIssues(duplicate).some((issue) => issue.code === "DUPLICATE_CAPABILITY"));

  const noFeature = manifest({
    capabilities: [{ id: "resource.cloud-drive", version: "1.0.0" }],
  });
  assert.equal(validatePluginManifest(noFeature), false);
  assert.ok(getPluginManifestIssues(noFeature).some((issue) => issue.code === "INVALID_CLOUD_DRIVE_FEATURE"));
});

test("rejects malformed IDs and non-SemVer implementation versions", () => {
  const malformedId = manifest({ id: "Example/unsafe" });
  assert.equal(validatePluginManifest(malformedId), false);
  assert.ok(getPluginManifestIssues(malformedId).some((issue) => issue.code === "INVALID_PLUGIN_ID"));

  const malformedVersion = manifest({ version: "latest" });
  assert.equal(validatePluginManifest(malformedVersion), false);
  assert.ok(getPluginManifestIssues(malformedVersion).some((issue) => issue.code === "INVALID_SEMVER"));
});

test("requires an explicit compliance declaration and rejects wildcard network access", () => {
  const missingCompliance = manifest({ compliance: undefined });
  assert.equal(validatePluginManifest(missingCompliance), false);
  assert.ok(getPluginManifestIssues(missingCompliance).some((issue) => issue.code === "MISSING_COMPLIANCE"));

  const wildcard = manifest({
    permissions: {
      networkHosts: ["*.example.com"],
      secrets: [],
      storage: "none",
    },
  });
  assert.equal(validatePluginManifest(wildcard), false);
  assert.ok(getPluginManifestIssues(wildcard).some((issue) => issue.code === "DANGEROUS_NETWORK_HOST"));

  assert.throws(
    () => assertPluginManifest(wildcard),
    (error: unknown) => {
      assert.ok(error instanceof PluginError);
      assert.equal(error.code, "DANGEROUS_NETWORK_HOST");
      assert.ok(error.issues?.some((issue) => issue.code === "DANGEROUS_NETWORK_HOST"));
      return true;
    }
  );
});

test("requires secret config fields to be explicitly marked and typed", () => {
  const missingMarker = manifest({
    config: {
      version: "1.0",
      fields: [{ key: "token", type: "secret" }],
    },
  });
  assert.ok(getPluginManifestIssues(missingMarker).some((issue) => issue.code === "INVALID_PERMISSION"));

  const wrongType = manifest({
    config: {
      version: "1.0",
      fields: [{ key: "token", type: "string", secret: true }],
    },
  });
  assert.ok(getPluginManifestIssues(wrongType).some((issue) => issue.code === "INVALID_PERMISSION"));
});

test("keeps provider/source attribution separate from platform/brand data", () => {
  const candidate = {
    contentId: "content_01",
    providerId: "example.catalog",
    externalId: "upstream-42",
    title: "Example",
    platform: { platformId: "cloud-drive", brand: "Example Drive" },
    availability: "available" as const,
    provenance: {
      source: { providerId: "example.catalog", sourceId: "licensed-feed" },
      pluginVersion: "1.2.3",
      fetchedAt: "2026-08-19T00:00:00.000Z",
    },
    kind: "cloud-drive" as const,
    url: "https://drive.example.com/share/42",
  };

  assert.equal(candidate.providerId, "example.catalog");
  assert.equal(candidate.platform.platformId, "cloud-drive");
  assert.notEqual(candidate.providerId, candidate.platform.platformId);
});

test("capability interfaces stay independently implementable and carry AbortSignal context", async () => {
  const detail: ContentDetailCapability = {
    async detail(receivedContext) {
      assert.equal(receivedContext.runtime, "server");
      return null;
    },
  };
  const search: CloudDriveSearchCapability = {
    async search() {
      return { items: [] };
    },
  };
  const context: PluginContext = {
    runtime: "server",
    requestId: "request-1",
    profile: "default",
    locale: "zh-CN",
    region: "CN",
    deadline: "2026-08-19T00:00:00.000Z",
    signal: new AbortController().signal,
    config: {},
    secrets: { get: () => undefined },
    storage: {
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {},
    },
    logger: { info() {}, warn() {}, error() {} },
  };

  assert.equal(context.signal.aborted, false);
  assert.equal(typeof detail.detail, "function");
  assert.equal(typeof search.search, "function");
  await detail.detail(context, {
    content: { contentId: "content_01", externalRefs: [] },
  });

  const validManifest = manifest();
  assertPluginManifest(validManifest);
  const plugin: Plugin = {
    manifest: validManifest,
    capabilities: { "content.detail": detail },
  };
  assert.ok(plugin.capabilities["content.detail"]);
});
