import assert from "node:assert/strict";
import test from "node:test";

import {
  ContentIdentityConflictError,
  isValidContentId,
  resolveContentIdentity,
} from "@/lib/content-identity-db";
import { createPanResourceInDB } from "@/lib/pan-resources-db";

test("content IDs use UUID format", () => {
  assert.equal(isValidContentId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isValidContentId("douban-123"), false);
});

test("identity resolver rejects empty or malformed external references before database access", async () => {
  await assert.rejects(
    () => resolveContentIdentity([]),
    (error: unknown) => error instanceof RangeError && /至少需要一个/.test(error.message)
  );
  await assert.rejects(
    () => resolveContentIdentity([{ providerId: "Bad Provider", externalId: "1" }]),
    (error: unknown) => error instanceof RangeError && /providerId/.test(error.message)
  );
  assert.equal(ContentIdentityConflictError.name, "ContentIdentityConflictError");
});

test("resource writes require a complete, valid provider identity before database access", async () => {
  const input = {
    douban_id: "1292052",
    brand: "quark" as const,
    title: "测试资源",
    url: "https://pan.quark.cn/s/example",
  };
  await assert.rejects(
    () => createPanResourceInDB({ ...input, provider_id: "example.provider" }),
    (error: unknown) => error instanceof RangeError && /必须同时提供/.test(error.message)
  );
  await assert.rejects(
    () => createPanResourceInDB({
      ...input,
      provider_id: "Bad Provider",
      provider_resource_id: "1",
    }),
    (error: unknown) => error instanceof RangeError && /provider_id/.test(error.message)
  );
});
