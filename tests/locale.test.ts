import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import {
  getRequestLocale,
  getRequestPluginProfileId,
} from "@/lib/plugins/request-profile";

test("public locale cookie selects only the corresponding built-in profile", () => {
  const request = new NextRequest("http://localhost/api/content/catalog", {
    headers: { cookie: "kk_locale=en-US" },
  });
  assert.equal(getRequestPluginProfileId(request), "en-default");
  assert.equal(getRequestLocale(request), "en-US");
});

test("missing or invalid locale cookies preserve the deployment default", () => {
  const missing = new NextRequest("http://localhost/api/content/catalog");
  assert.equal(getRequestPluginProfileId(missing), "cn-default");
  assert.equal(getRequestLocale(missing), "zh-CN");

  const invalid = new NextRequest("http://localhost/api/content/catalog", {
    headers: { cookie: "kk_locale=fr-FR" },
  });
  assert.equal(getRequestPluginProfileId(invalid), "cn-default");
  assert.equal(getRequestLocale(invalid), "zh-CN");
});

