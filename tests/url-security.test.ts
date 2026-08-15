import assert from "node:assert/strict";
import test from "node:test";

import { assertSafeOutboundUrl } from "@/lib/url-security";

test("assertSafeOutboundUrl accepts public HTTPS targets", async () => {
  const url = await assertSafeOutboundUrl("https://cdn.example.com/poster.jpg", {
    resolveHostname: async () => ["203.0.113.10"],
  });

  assert.equal(url.href, "https://cdn.example.com/poster.jpg");
});

test("assertSafeOutboundUrl rejects loopback IPv4 targets", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("http://127.0.0.1:8080/secret"),
    /blocked/i
  );
});

test("assertSafeOutboundUrl rejects loopback IPv6 literal targets", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("http://[::1]:8080/secret"),
    /blocked/i
  );
});

test("assertSafeOutboundUrl rejects IPv4-mapped loopback IPv6 literal targets", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("http://[::ffff:127.0.0.1]/secret"),
    /blocked/i
  );
});

test("assertSafeOutboundUrl rejects metadata targets", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data"),
    /blocked/i
  );
});

test("assertSafeOutboundUrl rejects hostnames that resolve to private IPs", async () => {
  await assert.rejects(
    () =>
      assertSafeOutboundUrl("https://internal.example.com/feed.m3u8", {
        resolveHostname: async () => ["10.0.0.5"],
      }),
    /blocked/i
  );
});

test("assertSafeOutboundUrl accepts public IPv6 literal targets without DNS lookup", async () => {
  const url = await assertSafeOutboundUrl("https://[2606:4700:4700::1111]/poster.jpg", {
    resolveHostname: async () => {
      throw new Error("resolver should not be called for IP literals");
    },
  });

  assert.equal(url.href, "https://[2606:4700:4700::1111]/poster.jpg");
});
