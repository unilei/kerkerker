import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET as getContentDetail } from "@/app/api/content/detail/[id]/route";

test("content detail route maps the profile plugin DTO to the legacy detail shape", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/api\/v1\/detail\/1292052$/);
    assert.ok(init?.signal);
    return new Response(
      JSON.stringify({
        id: "1292052",
        internal_id: 42,
        title: "肖申克的救赎",
        rate: "9.7",
        url: "https://movie.example/1292052",
        cover: "https://image.example/poster.jpg",
        types: ["剧情"],
        directors: ["弗兰克·德拉邦特"],
        actors: ["蒂姆·罗宾斯"],
        duration: "142分钟",
        region: "美国",
        release_year: "1994",
        episodes_count: "",
        description: "希望让人自由。",
        photos: [{ id: "p1", image: "https://image.example/still.jpg", thumb: "https://image.example/thumb.jpg" }],
        comments: [{ id: "c1", content: "经典。", author: { name: "观众" } }],
        recommendations: [{ id: "1292053", title: "阿甘正传", cover: "https://image.example/rec.jpg", rate: "9.5", url: "https://movie.example/1292053" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const response = await getContentDetail(
      new NextRequest("http://localhost/api/content/detail/1292052"),
      { params: Promise.resolve({ id: "1292052" }) }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.profile, "cn-default");
    assert.equal(body.data.title, "肖申克的救赎");
    assert.equal(body.data.internal_id, 42);
    assert.deepEqual(body.data.types, ["剧情"]);
    assert.equal(body.data.photos[0].thumb, "https://image.example/thumb.jpg");
    assert.equal(body.data.recommendations[0].id, "1292053");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("content detail route rejects malformed external IDs before plugin access", async () => {
  const response = await getContentDetail(
    new NextRequest("http://localhost/api/content/detail/%2Fbad"),
    { params: Promise.resolve({ id: "/bad" }) }
  );
  assert.equal(response.status, 400);
});

test("content detail route preserves opaque IDs without allowing path injection", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/api\/v1\/detail\/abc%3Fedition%3D1$/);
    return new Response(
      JSON.stringify({ id: "abc?edition=1", title: "Opaque ID", rate: "", url: "", cover: "" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const response = await getContentDetail(
      new NextRequest("http://localhost/api/content/detail/abc%3Fedition%3D1"),
      { params: Promise.resolve({ id: "abc?edition=1" }) }
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
