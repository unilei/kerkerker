import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  createIdentityAuditRouteHandlers,
} from "@/app/api/plugins/identity-audit/route";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import type { ContentIdentityAuditReport } from "@/lib/content-identity-audit";

const report: ContentIdentityAuditReport = {
  scope: ["content_identities", "pan_resources", "pan_sync_targets"],
  identities: {
    total: 1,
    valid: 1,
    invalidContentId: 0,
    missingExternalRefs: 0,
    invalidExternalRefs: 0,
    duplicateContentIds: 0,
    duplicateExternalRefs: 0,
    orphanIdentities: 0,
  },
  collections: {
    pan_resources: {
      total: 1,
      contentIdPresent: 1,
      contentIdMissing: 0,
      contentIdInvalid: 0,
      contentIdConsistent: 1,
      contentIdPendingBackfill: 0,
      contentIdConflict: 0,
      doubanIdPresent: 1,
      doubanIdMissing: 0,
      doubanIdInvalid: 0,
      contentOnly: 0,
      providerPairComplete: 0,
      providerPairMissing: 1,
      providerPairInvalid: 0,
      kkpanIdentityComplete: 0,
      kkpanIdentityRecoverable: 0,
      kkpanIdentityConflict: 0,
      duplicateProviderPairs: 0,
    },
    pan_sync_targets: {
      total: 0,
      contentIdPresent: 0,
      contentIdMissing: 0,
      contentIdInvalid: 0,
      contentIdConsistent: 0,
      contentIdPendingBackfill: 0,
      contentIdConflict: 0,
      doubanIdPresent: 0,
      doubanIdMissing: 0,
      doubanIdInvalid: 0,
      contentOnly: 0,
      providerPairComplete: 0,
      providerPairMissing: 0,
      providerPairInvalid: 0,
      kkpanIdentityComplete: 0,
      kkpanIdentityRecoverable: 0,
      kkpanIdentityConflict: 0,
      duplicateProviderPairs: 0,
    },
  },
  pendingBackfill: 0,
  blockingConflictCount: 2,
  oldDoubanLinkCount: 1,
  issues: [
    {
      collection: "pan_resources",
      documentId: "resource-a",
      code: "link.content_id_without_identity",
      severity: "conflict",
      message: "资源身份不存在",
    },
    {
      collection: "pan_resources",
      documentId: "resource-b",
      code: "link.invalid_content_id",
      severity: "conflict",
      message: "content_id 无效",
    },
  ],
};

function authenticatedRequest(url: string): NextRequest {
  const secret = "identity-audit-route-test";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(url, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

test("identity audit endpoint requires an admin session before loading Mongo", async () => {
  let loads = 0;
  const handlers = createIdentityAuditRouteHandlers({
    loadReport: async () => {
      loads += 1;
      return report;
    },
  });

  const response = await handlers.GET(
    new NextRequest("http://localhost/api/plugins/identity-audit")
  );

  assert.equal(response.status, 401);
  assert.equal(loads, 0);
});

test("identity audit endpoint filters and bounds returned conflicts", async () => {
  const handlers = createIdentityAuditRouteHandlers({
    loadReport: async () => report,
  });
  const response = await handlers.GET(
    authenticatedRequest(
      "http://localhost/api/plugins/identity-audit?conflicts_only=true&limit=1"
    )
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.filters.conflictsOnly, true);
  assert.equal(body.data.filters.issueLimit, 1);
  assert.equal(body.data.report.issueCount, 2);
  assert.equal(body.data.report.issues.length, 1);
  assert.equal(body.data.report.issuesTruncated, true);
  assert.equal(body.data.report.blockingConflictCount, 2);
});

test("identity audit endpoint rejects malformed query parameters", async () => {
  let loads = 0;
  const handlers = createIdentityAuditRouteHandlers({
    loadReport: async () => {
      loads += 1;
      return report;
    },
  });

  for (const query of ["limit=0", "limit=nope", "conflicts_only=yes"]) {
    const response = await handlers.GET(
      authenticatedRequest(`http://localhost/api/plugins/identity-audit?${query}`)
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).data, null);
  }
  assert.equal(loads, 0);
});

test("identity audit endpoint maps infrastructure failures to a generic 500", async () => {
  const handlers = createIdentityAuditRouteHandlers({
    loadReport: async () => {
      throw new Error("database credentials must not leak");
    },
  });
  const response = await handlers.GET(
    authenticatedRequest("http://localhost/api/plugins/identity-audit")
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.message, "获取内容身份审计失败");
  assert.equal(body.data, null);
  assert.doesNotMatch(JSON.stringify(body), /database credentials/);
});
