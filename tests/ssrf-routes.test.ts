import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST as dramaList } from "@/app/api/drama/list/route";
import { POST as dramaDetail } from "@/app/api/drama/detail/route";
import { POST as dramaCategories } from "@/app/api/drama/categories/route";
import { POST as dramaParse } from "@/app/api/drama/parse/route";

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// SSRF 防御：所有从请求体接收 source 的路由必须拒绝内网目标。
// 校验发生在 fetch 之前，因此不会真正发起对外请求。

test("drama/list rejects sources pointing at internal hosts", async () => {
  const response = await dramaList(
    jsonRequest("http://localhost/api/drama/list", {
      source: { api: "http://127.0.0.1:8080" },
    })
  );

  assert.equal(response.status, 400);
});

test("drama/list rejects sources with internal search proxies", async () => {
  const response = await dramaList(
    jsonRequest("http://localhost/api/drama/list", {
      source: {
        api: "https://public.example.com/api",
        searchProxy: "http://169.254.169.254/latest/meta-data",
      },
      keyword: "test",
    })
  );

  assert.equal(response.status, 400);
});

test("drama/detail rejects sources pointing at internal hosts", async () => {
  const response = await dramaDetail(
    jsonRequest("http://localhost/api/drama/detail", {
      source: { api: "http://10.0.0.5" },
      ids: "1",
    })
  );

  assert.equal(response.status, 400);
});

test("drama/categories rejects sources pointing at internal hosts", async () => {
  const response = await dramaCategories(
    jsonRequest("http://localhost/api/drama/categories", {
      source: { api: "http://192.168.1.1" },
    })
  );

  assert.equal(response.status, 400);
});

test("drama/parse rejects parseProxy pointing at internal hosts", async () => {
  const response = await dramaParse(
    jsonRequest("http://localhost/api/drama/parse", {
      url: "https://public.example.com/video.m3u8",
      source: { parseProxy: "http://127.0.0.1:9090/parse" },
    })
  );

  assert.equal(response.status, 400);
});
