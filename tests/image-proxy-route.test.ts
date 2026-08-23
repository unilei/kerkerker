import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET as getImageProxy } from "@/app/api/image-proxy/route";

const IMAGE_URL = "https://image.tmdb.org/t/p/w500/example.jpg";

test("TMDB image proxy accepts a direct image response", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith(IMAGE_URL)) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response("proxy should not be needed", { status: 502 });
  };
  try {
    const response = await getImageProxy(
      new NextRequest(`http://localhost/api/image-proxy?url=${encodeURIComponent(IMAGE_URL)}`)
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("TMDB image proxy rejects non-image upstream responses and uses a proxy fallback", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const hostname = new URL(String(input)).hostname;
    if (hostname === "image.tmdb.org") {
      return new Response("blocked", { status: 403, headers: { "content-type": "text/plain" } });
    }
    return new Response(new Uint8Array([4, 5]), {
      status: 200,
      headers: { "content-type": "image/webp" },
    });
  };
  try {
    const response = await getImageProxy(
      new NextRequest(`http://localhost/api/image-proxy?url=${encodeURIComponent(IMAGE_URL)}`)
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
