import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  createIdentityLinkRouteHandlers,
  type IdentityLinkRouteDependencies,
} from "@/app/api/plugins/identity-links/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { ContentIdentityConflictError } from "@/lib/content-identity-db";
import { pluginRegistry } from "@/lib/plugins";
import type {
  ExternalReference,
  HostContentReference,
} from "@/lib/plugins/types";

const CONTENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const TMDB_ID = "kerkerker.tmdb-content";

function identity(externalRefs: readonly ExternalReference[] = []): HostContentReference {
  return {
    contentId: CONTENT_ID,
    externalRefs: [
      { providerId: "kerkerker.douban-content", externalId: "1292052" },
      ...externalRefs,
    ],
  };
}

function authenticatedRequest(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): NextRequest {
  const secret = "identity-link-route-test";
  process.env.ADMIN_SESSION_SECRET = secret;
  const token = createSessionToken({ secret });
  return new NextRequest(url, {
    method: init.method,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers || {}),
    },
  });
}

function deps(overrides: Partial<IdentityLinkRouteDependencies> = {}) {
  const descriptor = pluginRegistry.list().find((plugin) => plugin.id === TMDB_ID);
  assert.ok(descriptor);
  const writes: unknown[] = [];
  const before = identity();
  return {
    writes,
    handlers: createIdentityLinkRouteHandlers({
      findIdentity: async () => before,
      linkReference: async (_contentId, ref) => identity([ref]),
      listPlugins: () => [descriptor],
      ensureProviderAllowed: async () => ({
        allowed: true,
        wouldDeny: false,
        mode: "enforce" as const,
        reason: "approved" as const,
        pluginId: TMDB_ID,
        pluginVersion: descriptor.version,
      }),
      writeAudit: async (input) => {
        writes.push(input);
        return { event_id: "audit-1", ...input };
      },
      ...overrides,
    }),
  };
}

test("identity link routes require an admin session", async () => {
  const { handlers } = deps();
  const request = new NextRequest("http://localhost/api/plugins/identity-links", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
  });
  const response = await handlers.POST(request);
  assert.equal(response.status, 401);
});

test("identity link requires an existing identity, evidence, and a registered content plugin", async () => {
  const { handlers } = deps();
  const missingEvidence = await handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/identity-links", {
      method: "POST",
      body: {
        content_id: CONTENT_ID,
        provider_id: TMDB_ID,
        external_id: "603",
        reason: "人工核对同一作品",
      },
    })
  );
  assert.equal(missingEvidence.status, 400);
  assert.match((await missingEvidence.json()).message, /evidence_ref/);

  const unknownProvider = await handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/identity-links", {
      method: "POST",
      body: {
        content_id: CONTENT_ID,
        provider_id: "example.unknown",
        external_id: "603",
        reason: "人工核对同一作品",
        evidence_ref: "ticket-1",
      },
    })
  );
  assert.equal(unknownProvider.status, 400);
  assert.match((await unknownProvider.json()).message, /已注册/);
});

test("identity link performs an exact, audited cross-source mapping", async () => {
  const { handlers, writes } = deps();
  const response = await handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/identity-links", {
      method: "POST",
      body: {
        content_id: CONTENT_ID,
        provider_id: TMDB_ID,
        external_id: "603",
        canonical_url: "https://www.themoviedb.org/movie/603",
        reason: "人工核对片名、年份和官方页面",
        evidence_ref: "https://compliance.example/tickets/identity-1",
      },
      headers: { "x-request-id": "identity-link-1" },
    })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.added, true);
  assert.equal(body.data.identity.externalRefs.at(-1).providerId, TMDB_ID);
  assert.equal(writes.length, 1);
  assert.equal((writes[0] as { action: string }).action, "content.identity.link");
  assert.equal(
    (writes[0] as { metadata: { mapping_mode: string } }).metadata.mapping_mode,
    "manual-exact"
  );

  const read = await handlers.GET(
    authenticatedRequest(
      `http://localhost/api/plugins/identity-links?content_id=${CONTENT_ID}`
    )
  );
  assert.equal(read.status, 200);
  assert.equal((await read.json()).data.identity.contentId, CONTENT_ID);
});

test("identity link fails closed when policy denies the provider", async () => {
  let linked = false;
  const { handlers, writes } = deps({
    ensureProviderAllowed: async () => ({
      allowed: false,
      wouldDeny: true,
      mode: "enforce" as const,
      reason: "missing-policy" as const,
      pluginId: TMDB_ID,
      pluginVersion: "1.0.0",
    }),
    linkReference: async () => {
      linked = true;
      return identity();
    },
  });
  const response = await handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/identity-links", {
      method: "POST",
      body: {
        content_id: CONTENT_ID,
        provider_id: TMDB_ID,
        external_id: "603",
        reason: "人工核对同一作品",
        evidence_ref: "ticket-2",
      },
    })
  );
  assert.equal(response.status, 403);
  assert.equal(linked, false);
  assert.equal(writes.length, 0);
});

test("identity link reports a cross-source ownership conflict", async () => {
  const { handlers } = deps({
    linkReference: async () => {
      throw new ContentIdentityConflictError([
        CONTENT_ID,
        "550e8400-e29b-41d4-a716-446655440001",
      ]);
    },
  });
  const response = await handlers.POST(
    authenticatedRequest("http://localhost/api/plugins/identity-links", {
      method: "POST",
      body: {
        content_id: CONTENT_ID,
        provider_id: TMDB_ID,
        external_id: "603",
        reason: "人工核对同一作品",
        evidence_ref: "ticket-3",
      },
    })
  );
  assert.equal(response.status, 409);
  assert.deepEqual(
    (await response.json()).data.conflicting_content_ids,
    [CONTENT_ID, "550e8400-e29b-41d4-a716-446655440001"]
  );
});
