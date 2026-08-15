import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST as decryptConfig } from "@/app/api/decrypt/route";
import { POST as testDatabaseConnection } from "@/app/api/database/test/route";
import { POST as saveDailymotionConfig } from "@/app/api/dailymotion-config/route";
import { POST as savePlayerConfig } from "@/app/api/player-config/route";
import { POST as saveVodSources } from "@/app/api/vod-sources/route";

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("vod source updates require an authenticated admin session", async () => {
  const response = await saveVodSources(
    jsonRequest("http://localhost/api/vod-sources", {
      sources: [],
    })
  );

  assert.equal(response.status, 401);
});

test("player config updates require an authenticated admin session", async () => {
  const response = await savePlayerConfig(
    jsonRequest("http://localhost/api/player-config", {})
  );

  assert.equal(response.status, 401);
});

test("dailymotion config updates require an authenticated admin session", async () => {
  const response = await saveDailymotionConfig(
    jsonRequest("http://localhost/api/dailymotion-config", {
      action: "invalid",
    })
  );

  assert.equal(response.status, 401);
});

test("database diagnostics require an authenticated admin session", async () => {
  const response = await testDatabaseConnection();

  assert.equal(response.status, 401);
});

test("decrypt endpoint requires an authenticated admin session", async () => {
  const response = await decryptConfig(
    jsonRequest("http://localhost/api/decrypt", {
      password: "secret",
      encryptedData: "invalid",
    })
  );

  assert.equal(response.status, 401);
});
