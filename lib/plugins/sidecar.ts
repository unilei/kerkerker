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
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;

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
  readonly circuitBreaker?: SidecarCircuitBreaker;
}

export interface SidecarCircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

interface SidecarCircuitState {
  failures: number;
  openedAt?: number;
  probeInFlight: boolean;
}

/**
 * Process-local sidecar circuit breaker. The registry remains immutable; this
 * state only prevents a failing remote from being hammered by this host while
 * a cooldown probe determines whether it has recovered.
 */
export class SidecarCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, SidecarCircuitState>();

  constructor(options: SidecarCircuitBreakerOptions = {}) {
    const failureThreshold = options.failureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    const cooldownMs = options.cooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
    if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 100) {
      throw new RangeError("Sidecar 熔断失败阈值无效");
    }
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 100 || cooldownMs > 3_600_000) {
      throw new RangeError("Sidecar 熔断冷却时间无效");
    }
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = options.now || Date.now;
  }

  beforeRequest(key: string): void {
    const state = this.states.get(key);
    if (state?.openedAt === undefined) return;

    const elapsed = this.now() - state.openedAt;
    if (elapsed < this.cooldownMs) {
      throw new PluginError("UPSTREAM_ERROR", "远程插件暂时熔断，请稍后重试", {
        path: "runtime.circuit",
      });
    }
    if (state.probeInFlight) {
      throw new PluginError("UPSTREAM_ERROR", "远程插件正在进行恢复探测", {
        path: "runtime.circuit",
      });
    }
    state.probeInFlight = true;
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  recordFailure(key: string): { readonly opened: boolean; readonly failures: number } {
    const state = this.states.get(key) || { failures: 0, probeInFlight: false };
    state.failures += 1;
    state.probeInFlight = false;
    if (state.failures >= this.failureThreshold) {
      state.openedAt = this.now();
    }
    this.states.set(key, state);
    return { opened: Boolean(state.openedAt), failures: state.failures };
  }

  reset(key: string): void {
    this.states.delete(key);
  }

  get cooldownDurationMs(): number {
    return this.cooldownMs;
  }
}

export const defaultSidecarCircuitBreaker = new SidecarCircuitBreaker();

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
  entry: string,
  context: PluginContext,
  fetcher: typeof fetch
): Promise<void> {
  if (!runtime.health) return;
  const timeoutMs = runtime.health.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([context.signal, timeoutSignal]);
  const endpoint = healthUrl(entry, runtime.health.path);
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
  let entryUrl: URL;
  try {
    entryUrl = new URL(entry);
  } catch {
    return false;
  }
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

function configuredRemoteEntry(runtime: RemoteRuntime, context: PluginContext): string {
  const configured = context.config.serviceUrl;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : runtime.entry;
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
  const runtime = options.manifest.runtime as RemoteRuntime;
  const entry = configuredRemoteEntry(runtime, options.context);
  if (!isDeclaredNetworkHost(entry, options.manifest.permissions.networkHosts)) {
    throw new PluginError(
      "CONFIGURATION_ERROR",
      "远程插件入口不在 manifest.permissions.networkHosts 白名单中",
      { path: "permissions.networkHosts" }
    );
  }
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
  const endpoint = sidecarUrl(entry);
  await assertSafeOutboundUrl(endpoint);
  const fetcher = options.fetcher || fetch;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 10 * MAX_RESPONSE_BYTES) {
    throw new RangeError("远程插件响应大小限制无效");
  }
  const circuitBreaker = options.circuitBreaker || defaultSidecarCircuitBreaker;
  const circuitKey = `${options.manifest.id}@${options.manifest.version}`;
  circuitBreaker.beforeRequest(circuitKey);

  try {
    await checkRemoteHealth(runtime, entry, options.context, fetcher);

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
      const code = typeof envelope?.code === "string" ? envelope.code : "UPSTREAM_ERROR";
      const propagated = new Set([
        "CAPABILITY_UNAVAILABLE",
        "UNSUPPORTED_CAPABILITY",
        "CONFIGURATION_ERROR",
        "EXECUTION_CANCELLED",
      ]);
      throw new PluginError(
        propagated.has(code) ? code as PluginError["code"] : "UPSTREAM_ERROR",
        message,
        { path: code }
      );
    }
    circuitBreaker.recordSuccess(circuitKey);
    return payload as T;
  } catch (error) {
    if (error instanceof PluginError && error.code === "UPSTREAM_ERROR") {
      const result = circuitBreaker.recordFailure(circuitKey);
      if (result.opened) {
        options.context.logger.warn("plugin.sidecar.circuit_open", {
          pluginId: options.manifest.id,
          version: options.manifest.version,
          failures: result.failures,
          cooldownMs: circuitBreaker.cooldownDurationMs,
        });
      }
    }
    throw error;
  }
}
