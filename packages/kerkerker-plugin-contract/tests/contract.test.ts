import assert from "node:assert/strict";
import test from "node:test";
import {
  PLUGIN_CONTRACT_VERSION,
  isPluginCapabilityId,
  isPluginContractVersion,
  isPluginErrorEnvelope,
} from "../src/index.js";

test("v1 contract exposes stable capability and version guards", () => {
  assert.equal(PLUGIN_CONTRACT_VERSION, "1.0.0");
  assert.equal(isPluginCapabilityId("content.catalog"), true);
  assert.equal(isPluginCapabilityId("douban.catalog"), false);
  assert.equal(isPluginContractVersion("1.0"), true);
  assert.equal(isPluginContractVersion("1.0.0"), true);
  assert.equal(isPluginContractVersion("v1"), false);
});

test("error envelopes are safe to transport across a sidecar boundary", () => {
  assert.equal(
    isPluginErrorEnvelope({
      error: { code: "UPSTREAM_ERROR", message: "temporary failure", retryable: true },
    }),
    true
  );
  assert.equal(isPluginErrorEnvelope({ error: { code: "" } }), false);
  assert.equal(isPluginErrorEnvelope({ message: "not an envelope" }), false);
});
