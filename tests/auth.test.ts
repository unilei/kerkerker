import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionToken,
  validateSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";

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
