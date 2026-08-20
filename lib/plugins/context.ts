import { randomUUID } from "node:crypto";
import { PluginError } from "@/lib/plugins/errors";
import { pluginProfileRegistry } from "@/lib/plugins/builtin-profiles";
import type {
  PluginContext,
  PluginLogger,
  PluginSecretReader,
  PluginStorage,
} from "@/lib/plugins/types";

const DEFAULT_TIMEOUT_MS = 15_000;

const NOOP_LOGGER: PluginLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

const UNAVAILABLE_STORAGE: PluginStorage = Object.freeze({
  async get() {
    return undefined;
  },
  async set() {
    throw new PluginError("CONFIGURATION_ERROR", "当前插件调用未配置持久化存储");
  },
  async delete() {
    throw new PluginError("CONFIGURATION_ERROR", "当前插件调用未配置持久化存储");
  },
});

export interface CreatePluginContextOptions {
  profileId: string;
  requestId?: string;
  runId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  config?: Readonly<Record<string, unknown>>;
  secrets?: Readonly<Record<string, string | undefined>>;
  storage?: PluginStorage;
  logger?: PluginLogger;
}

function boundedTimeout(value?: number): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 100 || value > 5 * 60_000) {
    throw new RangeError("插件超时必须在 100ms 到 5 分钟之间");
  }
  return value;
}

/** Build a server-only context from a validated deployment profile. */
export function createPluginContext(options: CreatePluginContextOptions): PluginContext {
  const profile = pluginProfileRegistry.require(options.profileId);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const secretValues = Object.freeze({ ...(options.secrets || {}) });
  const secrets: PluginSecretReader = Object.freeze({
    get(name: string) {
      return Object.prototype.hasOwnProperty.call(secretValues, name)
        ? secretValues[name]
        : undefined;
    },
  });

  return Object.freeze({
    runtime: "server" as const,
    requestId: options.requestId || randomUUID(),
    ...(options.runId ? { runId: options.runId } : {}),
    profile: profile.id,
    locale: profile.locale,
    region: profile.region,
    deadline: new Date(Date.now() + timeoutMs).toISOString(),
    signal,
    config: Object.freeze({ ...(options.config || {}) }),
    secrets,
    storage: options.storage || UNAVAILABLE_STORAGE,
    logger: options.logger || NOOP_LOGGER,
  });
}
