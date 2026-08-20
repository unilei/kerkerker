import assert from "node:assert/strict";
import test from "node:test";

import {
  CN_DEFAULT_PROFILE_ID,
  createProfileInvocation,
} from "@/lib/plugins";

test("profile invocation injects content provider settings outside API routes", () => {
  const invocation = createProfileInvocation({
    profileId: CN_DEFAULT_PROFILE_ID,
    capability: "content.detail",
    timeoutMs: 1_000,
  });
  assert.equal(invocation.pluginId, "kerkerker.douban-content");
  assert.equal(typeof invocation.context.config.baseUrl, "string");
  assert.equal(invocation.context.profile, CN_DEFAULT_PROFILE_ID);
  assert.equal(invocation.context.locale, "zh-CN");
});

test("profile invocation injects cloud-drive settings for the selected plugin", () => {
  const invocation = createProfileInvocation({
    profileId: CN_DEFAULT_PROFILE_ID,
    capability: "resource.cloud-drive",
    timeoutMs: 1_000,
  });
  assert.equal(invocation.pluginId, "kerkerker.kkpan-cloud-drive");
  assert.equal(typeof invocation.context.config.baseUrl, "string");
});

test("profile invocation rejects a runtime host outside the manifest permission", () => {
  const previous = process.env.KKPAN_API_BASE;
  process.env.KKPAN_API_BASE = "https://unapproved.example";
  try {
    assert.throws(
      () =>
        createProfileInvocation({
          profileId: CN_DEFAULT_PROFILE_ID,
          capability: "resource.cloud-drive",
          timeoutMs: 1_000,
        }),
      /不在网络权限声明中/
    );
  } finally {
    if (previous === undefined) delete process.env.KKPAN_API_BASE;
    else process.env.KKPAN_API_BASE = previous;
  }
});
