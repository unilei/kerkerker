import { assertSafeOutboundUrl } from "@/lib/url-security";
import { PluginError } from "@/lib/plugins/errors";
import type {
  PluginCapability,
  PluginContext,
  PluginManifest,
  PluginOperation,
} from "@/lib/plugins/types";

const MAX_RESPONSE_BYTES = 1_048_576;

interface SidecarFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

export interface InvokeSidecarOptions {
  readonly manifest: PluginManifest;
  readonly capability: PluginCapability;
  readonly operation: PluginOperation;
  readonly context: PluginContext;
  readonly request: unknown;
  readonly fetcher?: typeof fetch;
  readonly maxResponseBytes?: number;
}

function sidecarUrl(entry: string): string {
  const url = new URL(entry);
  if (url.protocol !== "https:") {
    throw new PluginError("INVALID_RUNTIME", "远程插件入口必须使用 HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/invoke`;
  url.search = "";
  return url.toString();
}

function isDeclaredNetworkHost(entry: string, networkHosts: readonly string[]): boolean {
  const entryUrl = new URL(entry);
  const entryHost = entryUrl.hostname.toLowerCase();
  return networkHosts.some((declared) => {
    const value = declared.trim();
    if (!value) return false;
    try {
      const declaredUrl = new URL(value.includes("://") ? value : `https://${value}`);
      return declaredUrl.protocol === "https:" && declaredUrl.hostname.toLowerCase() === entryHost;
    } catch {
      return value.toLowerCase() === entryHost;
    }
  });
}

function publicContext(context: PluginContext) {
  return {
    runtime: context.runtime,
    requestId: context.requestId,
    ...(context.runId ? { runId: context.runId } : {}),
    profile: context.profile,
    locale: context.locale,
    region: context.region,
    deadline: context.deadline,
    contractVersion: "1.0.0",
  };
}

async function readBoundedBody(response: SidecarFetchResponse, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        throw new PluginError("UPSTREAM_ERROR", "远程插件响应超过大小限制");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseSidecarPayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PluginError("UPSTREAM_ERROR", "远程插件返回了非法 JSON", { cause: error });
  }
}

/** Invoke a trusted remote sidecar through the fixed v1 JSON protocol. */
export async function invokeRemoteSidecar<T>(options: InvokeSidecarOptions): Promise<T> {
  if (options.manifest.runtime.mode !== "remote") {
    throw new PluginError("INVALID_RUNTIME", "只有 remote 插件可以调用 Sidecar");
  }
  if (!isDeclaredNetworkHost(options.manifest.runtime.entry, options.manifest.permissions.networkHosts)) {
    throw new PluginError(
      "CONFIGURATION_ERROR",
      "远程插件入口不在 manifest.permissions.networkHosts 白名单中",
      { path: "permissions.networkHosts" }
    );
  }
  const endpoint = sidecarUrl(options.manifest.runtime.entry);
  await assertSafeOutboundUrl(endpoint);
  const fetcher = options.fetcher || fetch;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 10 * MAX_RESPONSE_BYTES) {
    throw new RangeError("远程插件响应大小限制无效");
  }

  let response: SidecarFetchResponse;
  try {
    response = (await fetcher(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-kerkerker-request-id": options.context.requestId,
      },
      body: JSON.stringify({
        contractVersion: "1.0.0",
        capability: options.capability,
        operation: options.operation,
        context: publicContext(options.context),
        request: options.request,
      }),
      signal: options.context.signal,
    })) as SidecarFetchResponse;
  } catch (error) {
    if (options.context.signal.aborted) {
      throw new PluginError("EXECUTION_CANCELLED", "远程插件调用已取消", { cause: error });
    }
    throw new PluginError("UPSTREAM_ERROR", "远程插件请求失败", { cause: error });
  }

  const text = await readBoundedBody(response, maxBytes);
  const payload = parseSidecarPayload(text);
  if (!response.ok) {
    const envelope = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
    const message = typeof envelope?.message === "string" ? envelope.message : `远程插件 HTTP ${response.status}`;
    throw new PluginError("UPSTREAM_ERROR", message, { path: typeof envelope?.code === "string" ? envelope.code : undefined });
  }
  return payload as T;
}
