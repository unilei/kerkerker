import { assertSafeOutboundUrl } from "@/lib/url-security";
import { PluginError } from "@/lib/plugins/errors";
import {
  PLUGIN_CONTRACT_VERSION,
} from "@/lib/plugins/types";
import type {
  PluginCapability,
  PluginContext,
  PluginContractVersion,
  PluginManifest,
  PluginOperation,
} from "@/lib/plugins/types";

const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const PROTOCOL_VERSION_HEADER = "x-kerkerker-contract-version";
const PROTOCOL_VERSIONS_HEADER = "x-kerkerker-contract-versions";

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

type RemoteRuntime = PluginManifest["runtime"] & { readonly mode: "remote" };

function isContractVersion(value: string): value is PluginContractVersion {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(value);
}

function sameContractLine(left: string, right: string): boolean {
  return left.split(".").slice(0, 2).join(".") === right.split(".").slice(0, 2).join(".");
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

function healthUrl(entry: string, path: string): string {
  const url = new URL(entry);
  if (url.protocol !== "https:") {
    throw new PluginError("INVALID_RUNTIME", "远程插件入口必须使用 HTTPS");
  }
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function authHeaders(
  runtime: RemoteRuntime,
  context: PluginContext
): Record<string, string> {
  if (!runtime.auth) return {};
  const secret = context.secrets.get(runtime.auth.secret);
  if (!secret) {
    throw new PluginError(
      "CONFIGURATION_ERROR",
      `远程插件缺少宿主认证密钥：${runtime.auth.secret}`,
      { path: `runtime.auth.secret` }
    );
  }
  if (runtime.auth.type === "bearer") {
    return { authorization: `Bearer ${secret}` };
  }
  return { [runtime.auth.header || "x-kerkerker-secret"]: secret };
}

function protocolHeaders(runtime: RemoteRuntime): Record<string, string> {
  const versions = runtime.protocolVersions;
  if (!versions || versions.length === 0) return {};
  return {
    [PROTOCOL_VERSIONS_HEADER]: versions.join(","),
    [PROTOCOL_VERSION_HEADER]: PLUGIN_CONTRACT_VERSION,
  };
}

function assertNegotiatedProtocol(
  runtime: RemoteRuntime,
  response: SidecarFetchResponse
): void {
  const versions = runtime.protocolVersions;
  if (!versions || versions.length === 0) return;
  const selected = response.headers.get(PROTOCOL_VERSION_HEADER);
  if (!selected || !isContractVersion(selected)) {
    throw new PluginError(
      "UPSTREAM_ERROR",
      "远程插件未返回可验证的契约版本",
      { path: PROTOCOL_VERSION_HEADER }
    );
  }
  if (!versions.includes(selected) && !versions.some((version) => sameContractLine(version, selected))) {
    throw new PluginError(
      "UPSTREAM_ERROR",
      `远程插件协商了不兼容的契约版本：${selected}`,
      { path: PROTOCOL_VERSION_HEADER }
    );
  }
}

async function checkRemoteHealth(
  runtime: RemoteRuntime,
  context: PluginContext,
  fetcher: typeof fetch
): Promise<void> {
  if (!runtime.health) return;
  const timeoutMs = runtime.health.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([context.signal, timeoutSignal]);
  const endpoint = healthUrl(runtime.entry, runtime.health.path);
  await assertSafeOutboundUrl(endpoint);
  const headers = {
    accept: "application/json, text/plain",
    "x-kerkerker-request-id": context.requestId,
    ...protocolHeaders(runtime),
    ...authHeaders(runtime, context),
  };
  let response: SidecarFetchResponse;
  try {
    response = (await fetcher(endpoint, {
      method: "GET",
      headers,
      signal,
    })) as SidecarFetchResponse;
  } catch (error) {
    if (context.signal.aborted) {
      throw new PluginError("EXECUTION_CANCELLED", "远程插件健康检查已取消", { cause: error });
    }
    if (timeoutSignal.aborted) {
      throw new PluginError("UPSTREAM_ERROR", "远程插件健康检查超时", { cause: error });
    }
    throw new PluginError("UPSTREAM_ERROR", "远程插件健康检查失败", { cause: error });
  }
  if (!response.ok) {
    throw new PluginError("UPSTREAM_ERROR", `远程插件健康检查 HTTP ${response.status}`, {
      path: "runtime.health",
    });
  }
  assertNegotiatedProtocol(runtime, response);
  await response.body?.cancel();
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
  const runtime = options.manifest.runtime as RemoteRuntime;
  if (
    runtime.auth &&
    !options.manifest.permissions.secrets.includes(runtime.auth.secret)
  ) {
    throw new PluginError(
      "CONFIGURATION_ERROR",
      "远程插件认证密钥未声明为宿主权限",
      { path: "runtime.auth.secret" }
    );
  }
  const endpoint = sidecarUrl(runtime.entry);
  await assertSafeOutboundUrl(endpoint);
  const fetcher = options.fetcher || fetch;
  await checkRemoteHealth(runtime, options.context, fetcher);
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 10 * MAX_RESPONSE_BYTES) {
    throw new RangeError("远程插件响应大小限制无效");
  }

  let response: SidecarFetchResponse;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "x-kerkerker-request-id": options.context.requestId,
    ...protocolHeaders(runtime),
    ...authHeaders(runtime, options.context),
  };
  try {
    response = (await fetcher(endpoint, {
      method: "POST",
      headers,
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
  assertNegotiatedProtocol(runtime, response);
  if (!response.ok) {
    const envelope = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
    const message = typeof envelope?.message === "string" ? envelope.message : `远程插件 HTTP ${response.status}`;
    throw new PluginError("UPSTREAM_ERROR", message, { path: typeof envelope?.code === "string" ? envelope.code : undefined });
  }
  return payload as T;
}
