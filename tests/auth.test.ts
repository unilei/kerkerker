import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionToken,
  isSecureRequest,
  validateSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import { NextRequest } from "next/server";

test("session cookie name stays stable for admin flows", () => {
  assert.equal(SESSION_COOKIE_NAME, "admin_session");
});

test("validateSessionToken rejects the forged legacy cookie value", () => {
  assert.equal(
    validateSessionToken("authenticated", {
      secret: "test-secret",
      now: Date.parse("2026-04-17T00:00:00Z"),
    }),
    false
  );
});

test("validateSessionToken accepts tokens issued by createSessionToken", () => {
  const issuedAt = Date.parse("2026-04-17T00:00:00Z");
  const token = createSessionToken({
    secret: "test-secret",
    now: issuedAt,
    maxAge: 60,
  });

  assert.equal(
    validateSessionToken(token, {
      secret: "test-secret",
      now: issuedAt + 30_000,
    }),
    true
  );
});

test("validateSessionToken rejects expired tokens", () => {
  const issuedAt = Date.parse("2026-04-17T00:00:00Z");
  const token = createSessionToken({
    secret: "test-secret",
    now: issuedAt,
    maxAge: 1,
  });

  assert.equal(
    validateSessionToken(token, {
      secret: "test-secret",
      now: issuedAt + 2_000,
    }),
    false
  );
});

test("isSecureRequest follows the browser-facing protocol", () => {
  assert.equal(isSecureRequest(new NextRequest("http://example.com/login")), false);
  assert.equal(isSecureRequest(new NextRequest("https://example.com/login")), true);

  const proxiedHttpsRequest = new NextRequest("http://example.com/login", {
    headers: { "x-forwarded-proto": "https, http" },
  });
  assert.equal(isSecureRequest(proxiedHttpsRequest), true);

  const proxiedHttpRequest = new NextRequest("https://example.com/login", {
    headers: { "x-forwarded-proto": "http" },
  });
  assert.equal(isSecureRequest(proxiedHttpRequest), false);
});
