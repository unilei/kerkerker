import assert from "node:assert/strict";
import test from "node:test";
import {
  auditContentIdentityGraph,
  type ContentIdentityAuditInputs,
} from "@/lib/content-identity-audit";
import { DOUBAN_CONTENT_PLUGIN_ID } from "@/lib/plugins/adapters/douban-content";
import { KKPAN_PLUGIN_ID } from "@/lib/plugins/adapters/kkpan-cloud-drive";

const CONTENT_ID_A = "550e8400-e29b-41d4-a716-446655440000";
const CONTENT_ID_B = "550e8400-e29b-41d4-a716-446655440001";

function baseInput(): ContentIdentityAuditInputs {
  return {
    identities: [
      {
        documentId: "identity-a",
        content_id: CONTENT_ID_A,
        external_refs: [{ provider_id: DOUBAN_CONTENT_PLUGIN_ID, external_id: "1292052" }],
      },
    ],
    panResources: [],
    panSyncTargets: [],
  };
}

test("reports consistent links and separately counts legacy records pending backfill", () => {
  const input = baseInput();
  input.panResources = [
    { documentId: "resource-consistent", content_id: CONTENT_ID_A, douban_id: "1292052" },
    { documentId: "resource-legacy", douban_id: "1292052" },
  ];
  const report = auditContentIdentityGraph(input);
  assert.equal(report.blockingConflictCount, 0);
  assert.equal(report.pendingBackfill, 1);
  assert.equal(report.collections.pan_resources.contentIdConsistent, 1);
  assert.equal(report.collections.pan_resources.contentIdMissing, 1);
  assert.equal(report.oldDoubanLinkCount, 2);
});

test("blocks mismatched content and Douban identity instead of guessing", () => {
  const input = baseInput();
  input.identities = [
    ...input.identities,
    {
      documentId: "identity-b",
      content_id: CONTENT_ID_B,
      external_refs: [{ provider_id: DOUBAN_CONTENT_PLUGIN_ID, external_id: "1292053" }],
    },
  ];
  input.panResources = [
    { documentId: "resource-mismatch", content_id: CONTENT_ID_B, douban_id: "1292052" },
  ];
  const report = auditContentIdentityGraph(input);
  assert.ok(report.issues.some((item) => item.code === "link.content_douban_mismatch"));
  assert.ok(report.blockingConflictCount > 0);
  assert.equal(report.collections.pan_resources.contentIdConflict > 0, true);
});

test("finds duplicate provider identity and inconsistent KKPAN compatibility fields", () => {
  const input = baseInput();
  input.panResources = [
    {
      documentId: "resource-one",
      content_id: CONTENT_ID_A,
      douban_id: "1292052",
      provider_id: KKPAN_PLUGIN_ID,
      provider_resource_id: "100",
      kkpan_id: 100,
      source: "kkpan",
    },
    {
      documentId: "resource-two",
      content_id: CONTENT_ID_A,
      douban_id: "1292052",
      provider_id: KKPAN_PLUGIN_ID,
      provider_resource_id: "100",
      kkpan_id: 101,
      source: "kkpan",
    },
  ];
  const report = auditContentIdentityGraph(input);
  assert.equal(report.collections.pan_resources.duplicateProviderPairs, 2);
  assert.ok(report.issues.some((item) => item.code === "link.provider_pair_duplicate"));
  assert.ok(report.issues.some((item) => item.code === "link.kkpan_identity_mismatch"));
});

test("fails closed for malformed identity graph and orphan content IDs", () => {
  const input = baseInput();
  input.identities = [...input.identities, {
    documentId: "identity-invalid",
    content_id: "not-a-uuid",
    external_refs: [{ provider_id: DOUBAN_CONTENT_PLUGIN_ID, external_id: "bad" }],
  }];
  input.panSyncTargets = [
    { documentId: "target-orphan", content_id: CONTENT_ID_B, douban_id: "1292053" },
  ];
  const report = auditContentIdentityGraph(input);
  assert.equal(report.identities.invalidContentId, 1);
  assert.ok(report.issues.some((item) => item.code === "link.content_id_without_identity"));
  assert.ok(report.blockingConflictCount >= 2);
});
