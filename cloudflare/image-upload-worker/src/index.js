const objectPathPrefix = "/objects/";
const allowedKeyPattern = /^[A-Za-z0-9._/-]+$/;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"Content-Type": "application/json; charset=utf-8"},
  });
}

function getObjectKey(request) {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(objectPathPrefix)) {
    return "";
  }

  const key = decodeURIComponent(pathname.slice(objectPathPrefix.length));
  if (!key || key.startsWith("/") || key.includes("..") || !allowedKeyPattern.test(key)) {
    return "";
  }
  return key;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({status: "ok"});
    }

    // 公开读:封面等静态对象走同域 GET(对象本就是公开内容)。
    if (request.method === "GET" && url.pathname.startsWith(objectPathPrefix)) {
      const key = getObjectKey(request);
      if (!key) {
        return jsonResponse({error: "invalid object key"}, 400);
      }
      const object = await env.IMAGES.get(key);
      if (!object) {
        return jsonResponse({error: "not found"}, 404);
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(object.body, {headers});
    }

    if (request.method !== "PUT") {
      return jsonResponse({error: "not found"}, 404);
    }

    if (!env.UPLOAD_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.UPLOAD_TOKEN}`) {
      return jsonResponse({error: "unauthorized"}, 401);
    }

    const key = getObjectKey(request);
    if (!key) {
      return jsonResponse({error: "invalid object key"}, 400);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.startsWith("image/")) {
      return jsonResponse({error: "image content type required"}, 415);
    }

    const cacheControl = request.headers.get("Cache-Control") || "public, max-age=31536000, immutable";
    await env.IMAGES.put(key, request.body, {
      httpMetadata: {contentType, cacheControl},
      customMetadata: {source: "aipan-image-upload"},
    });

    return jsonResponse({key}, 201);
  },
};
