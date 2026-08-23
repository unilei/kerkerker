import type { Collection, Document, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/lib/constants/db";
import { getDatabase } from "@/lib/db";
import { PluginError } from "@/lib/plugins/errors";
import { pluginRegistry } from "@/lib/plugins/builtin";

/**
 * Installation state is deliberately separate from the trusted registry and
 * the compliance policy. The registry owns executable code; this collection
 * only records which static entry an operator chose to activate.
 */
export const PLUGIN_INSTALLATION_STATUSES = [
  "available",
  "installed",
  "enabled",
  "disabled",
  "failed",
] as const;

export type PluginInstallationStatus =
  (typeof PLUGIN_INSTALLATION_STATUSES)[number];

const INSTALLED_STATUSES: readonly PluginInstallationStatus[] = [
  "installed",
  "enabled",
  "disabled",
];

const MAX_PLUGIN_ID_LENGTH = 200;
const MAX_ERROR_LENGTH = 2_000;

export interface PluginInstallationRecord {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly status: PluginInstallationStatus;
  readonly installedAt?: string;
  readonly enabledAt?: string;
  readonly disabledAt?: string;
  readonly failedAt?: string;
  readonly uninstalledAt?: string;
  readonly updatedAt: string;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly updatedBy?: { readonly type: "admin" | "system"; readonly id?: string };
}

export interface PluginInstallationMutation {
  readonly status: PluginInstallationStatus;
  readonly pluginVersion: string;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly updatedBy?: { readonly type: "admin" | "system"; readonly id?: string };
  readonly now?: string;
}

export interface PluginInstallationStore {
  get(pluginId: string): Promise<PluginInstallationRecord | null>;
  list(): Promise<readonly PluginInstallationRecord[]>;
  transition(
    pluginId: string,
    mutation: PluginInstallationMutation
  ): Promise<PluginInstallationRecord>;
}

export class PluginInstallationValidationError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "PluginInstallationValidationError";
  }
}

export class PluginInstallationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInstallationTransitionError";
  }
}

function boundedPluginId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized ||
    normalized.length > MAX_PLUGIN_ID_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/.test(
      normalized
    )
  ) {
    throw new PluginInstallationValidationError("插件 ID 格式无效");
  }
  return normalized;
}

function boundedVersion(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new PluginInstallationValidationError("插件版本格式无效");
  }
  return normalized;
}

function boundedStatus(value: unknown): PluginInstallationStatus {
  if (
    typeof value !== "string" ||
    !PLUGIN_INSTALLATION_STATUSES.includes(value as PluginInstallationStatus)
  ) {
    throw new PluginInstallationValidationError("插件安装状态无效");
  }
  return value as PluginInstallationStatus;
}

function boundedNow(value: string | undefined): string {
  const normalized = value?.trim() || new Date().toISOString();
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw new PluginInstallationValidationError("插件安装时间无效");
  }
  return parsed.toISOString();
}

function boundedError(
  value: PluginInstallationMutation["error"]
): PluginInstallationRecord["error"] | undefined {
  if (!value) return undefined;
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (!message || message.length > MAX_ERROR_LENGTH || /[\u0000-\u001f\u007f]/.test(message)) {
    throw new PluginInstallationValidationError("插件安装错误信息无效");
  }
  const code = value.code?.trim();
  if (code && (code.length > 100 || /[\u0000-\u001f\u007f]/.test(code))) {
    throw new PluginInstallationValidationError("插件安装错误代码无效");
  }
  return { ...(code ? { code } : {}), message };
}

function cloneRecord(record: PluginInstallationRecord): PluginInstallationRecord {
  return {
    ...record,
    ...(record.error ? { error: { ...record.error } } : {}),
    ...(record.updatedBy ? { updatedBy: { ...record.updatedBy } } : {}),
  };
}

function canTransition(
  from: PluginInstallationStatus,
  to: PluginInstallationStatus
): boolean {
  if (from === to) return true;
  const transitions: Record<PluginInstallationStatus, readonly PluginInstallationStatus[]> = {
    available: ["installed", "failed"],
    installed: ["enabled", "disabled", "available", "failed"],
    enabled: ["disabled", "available", "failed"],
    disabled: ["enabled", "available", "failed"],
    failed: ["available", "installed"],
  };
  return transitions[from].includes(to);
}

function normalizeMutation(
  pluginId: string,
  mutation: PluginInstallationMutation
): { pluginId: string; pluginVersion: string; status: PluginInstallationStatus; now: string; error?: PluginInstallationRecord["error"]; updatedBy?: PluginInstallationRecord["updatedBy"] } {
  return {
    pluginId: boundedPluginId(pluginId),
    pluginVersion: boundedVersion(mutation.pluginVersion),
    status: boundedStatus(mutation.status),
    now: boundedNow(mutation.now),
    ...(mutation.error ? { error: boundedError(mutation.error) } : {}),
    ...(mutation.updatedBy ? { updatedBy: { ...mutation.updatedBy } } : {}),
  };
}

function applyMutation(
  existing: PluginInstallationRecord | null,
  normalized: ReturnType<typeof normalizeMutation>
): PluginInstallationRecord {
  if (
    !existing &&
    !["available", "installed", "failed"].includes(normalized.status)
  ) {
    throw new PluginInstallationTransitionError(
      `插件不能从 available 转换为 ${normalized.status}`
    );
  }
  if (existing && existing.pluginVersion !== normalized.pluginVersion) {
    if (normalized.status !== "installed" && normalized.status !== "available") {
      throw new PluginInstallationTransitionError(
        "插件版本已变化，请重新安装后再启用"
      );
    }
  }
  if (existing && !canTransition(existing.status, normalized.status)) {
    throw new PluginInstallationTransitionError(
      `插件不能从 ${existing.status} 转换为 ${normalized.status}`
    );
  }

  const base: PluginInstallationRecord = {
    pluginId: normalized.pluginId,
    pluginVersion: normalized.pluginVersion,
    status: normalized.status,
    ...(existing?.installedAt ? { installedAt: existing.installedAt } : {}),
    ...(existing?.enabledAt ? { enabledAt: existing.enabledAt } : {}),
    ...(existing?.disabledAt ? { disabledAt: existing.disabledAt } : {}),
    ...(existing?.failedAt ? { failedAt: existing.failedAt } : {}),
    ...(existing?.uninstalledAt ? { uninstalledAt: existing.uninstalledAt } : {}),
    updatedAt: normalized.now,
    ...(normalized.updatedBy ? { updatedBy: normalized.updatedBy } : existing?.updatedBy ? { updatedBy: existing.updatedBy } : {}),
  };

  if (normalized.status === "installed") {
    return {
      ...base,
      installedAt: existing?.pluginVersion === normalized.pluginVersion && existing.installedAt
        ? existing.installedAt
        : normalized.now,
      ...(normalized.error ? { error: normalized.error } : {}),
    };
  }
  if (normalized.status === "enabled") {
    return {
      ...base,
      enabledAt: normalized.now,
      ...(existing?.error ? { error: existing.error } : {}),
    };
  }
  if (normalized.status === "disabled") {
    return { ...base, disabledAt: normalized.now };
  }
  if (normalized.status === "failed") {
    return {
      ...base,
      failedAt: normalized.now,
      error: normalized.error || { message: "插件安装失败" },
    };
  }
  return {
    ...base,
    uninstalledAt: normalized.now,
    ...(normalized.error ? { error: normalized.error } : {}),
  };
}

/** Simple store used by unit tests and local development without MongoDB. */
export class InMemoryPluginInstallationStore implements PluginInstallationStore {
  private readonly records = new Map<string, PluginInstallationRecord>();

  constructor(initial: readonly PluginInstallationRecord[] = []) {
    for (const record of initial) {
      this.records.set(record.pluginId, cloneRecord(record));
    }
  }

  async get(pluginId: string): Promise<PluginInstallationRecord | null> {
    const normalized = boundedPluginId(pluginId);
    const record = this.records.get(normalized);
    return record ? cloneRecord(record) : null;
  }

  async list(): Promise<readonly PluginInstallationRecord[]> {
    return [...this.records.values()]
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
      .map(cloneRecord);
  }

  async transition(
    pluginId: string,
    mutation: PluginInstallationMutation
  ): Promise<PluginInstallationRecord> {
    const normalized = normalizeMutation(pluginId, mutation);
    const next = applyMutation(this.records.get(normalized.pluginId) || null, normalized);
    this.records.set(normalized.pluginId, cloneRecord(next));
    return cloneRecord(next);
  }
}

interface PluginInstallationDocument extends Document {
  _id?: ObjectId;
  plugin_id: string;
  plugin_version: string;
  status: PluginInstallationStatus;
  installed_at?: string;
  enabled_at?: string;
  disabled_at?: string;
  failed_at?: string;
  uninstalled_at?: string;
  updated_at: string;
  error?: { code?: string; message: string };
  updated_by?: { type: "admin" | "system"; id?: string };
}

function toDocument(record: PluginInstallationRecord): PluginInstallationDocument {
  return {
    plugin_id: record.pluginId,
    plugin_version: record.pluginVersion,
    status: record.status,
    ...(record.installedAt ? { installed_at: record.installedAt } : {}),
    ...(record.enabledAt ? { enabled_at: record.enabledAt } : {}),
    ...(record.disabledAt ? { disabled_at: record.disabledAt } : {}),
    ...(record.failedAt ? { failed_at: record.failedAt } : {}),
    ...(record.uninstalledAt ? { uninstalled_at: record.uninstalledAt } : {}),
    updated_at: record.updatedAt,
    ...(record.error ? { error: { ...record.error } } : {}),
    ...(record.updatedBy ? { updated_by: { ...record.updatedBy } } : {}),
  };
}

function toRecord(document: PluginInstallationDocument): PluginInstallationRecord {
  const status = PLUGIN_INSTALLATION_STATUSES.includes(document.status)
    ? document.status
    : "failed";
  return {
    pluginId: boundedPluginId(document.plugin_id),
    pluginVersion: boundedVersion(document.plugin_version),
    status,
    ...(document.installed_at ? { installedAt: document.installed_at } : {}),
    ...(document.enabled_at ? { enabledAt: document.enabled_at } : {}),
    ...(document.disabled_at ? { disabledAt: document.disabled_at } : {}),
    ...(document.failed_at ? { failedAt: document.failed_at } : {}),
    ...(document.uninstalled_at ? { uninstalledAt: document.uninstalled_at } : {}),
    updatedAt: boundedNow(document.updated_at),
    ...(document.error?.message ? { error: boundedError(document.error) } : {}),
    ...(document.updated_by ? { updatedBy: { ...document.updated_by } } : {}),
  };
}

function duplicateKey(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === 11000
  );
}

/** Mongo-backed installation state. It stores no executable plugin payload. */
export class MongoPluginInstallationStore implements PluginInstallationStore {
  private indexesPromise: Promise<void> | undefined;

  constructor(private readonly collection: Collection<PluginInstallationDocument>) {}

  private ensureIndexes(): Promise<void> {
    if (!this.indexesPromise) {
      this.indexesPromise = Promise.all([
        this.collection.createIndex(
          { plugin_id: 1 },
          { unique: true, name: "plugin_installation_identity" }
        ),
        this.collection.createIndex(
          { status: 1, updated_at: -1 },
          { name: "plugin_installation_status" }
        ),
      ]).then(() => undefined);
    }
    return this.indexesPromise;
  }

  async get(pluginId: string): Promise<PluginInstallationRecord | null> {
    await this.ensureIndexes();
    const document = await this.collection.findOne({ plugin_id: boundedPluginId(pluginId) });
    return document ? toRecord(document) : null;
  }

  async list(): Promise<readonly PluginInstallationRecord[]> {
    await this.ensureIndexes();
    const documents = await this.collection.find({}).sort({ plugin_id: 1 }).toArray();
    return documents.map(toRecord);
  }

  async transition(
    pluginId: string,
    mutation: PluginInstallationMutation
  ): Promise<PluginInstallationRecord> {
    await this.ensureIndexes();
    const normalized = normalizeMutation(pluginId, mutation);
    const existing = await this.get(normalized.pluginId);
    const next = applyMutation(existing, normalized);
    try {
      const result = await this.collection.replaceOne(
        existing ? { plugin_id: normalized.pluginId, status: existing.status } : { plugin_id: normalized.pluginId },
        toDocument(next),
        { upsert: !existing }
      );
      if (!result.matchedCount && !result.upsertedCount) {
        throw new PluginInstallationTransitionError("插件安装状态发生并发更新，请重试");
      }
    } catch (error) {
      if (duplicateKey(error)) {
        throw new PluginInstallationTransitionError("插件安装状态发生并发更新，请重试");
      }
      throw error;
    }
    return next;
  }
}

const globalInstallationState = globalThis as unknown as {
  pluginInstallationFallback?: InMemoryPluginInstallationStore;
  pluginInstallationStorePromise?: Promise<PluginInstallationStore>;
};

function fallbackStore(): InMemoryPluginInstallationStore {
  if (!globalInstallationState.pluginInstallationFallback) {
    globalInstallationState.pluginInstallationFallback = new InMemoryPluginInstallationStore();
  }
  return globalInstallationState.pluginInstallationFallback;
}

/** Use Mongo when configured; test/local processes without Mongo use memory. */
export async function getPluginInstallationStore(): Promise<PluginInstallationStore> {
  if (!globalInstallationState.pluginInstallationStorePromise) {
    globalInstallationState.pluginInstallationStorePromise = (async () => {
      if (!process.env.MONGODB_URI) return fallbackStore();
      const db = await getDatabase();
      return new MongoPluginInstallationStore(
        db.collection<PluginInstallationDocument>(COLLECTIONS.PLUGIN_INSTALLATIONS)
      );
    })();
  }
  try {
    return await globalInstallationState.pluginInstallationStorePromise;
  } catch (error) {
    // Production must fail closed when Mongo is configured but unavailable.
    globalInstallationState.pluginInstallationStorePromise = undefined;
    throw error;
  }
}

export interface RequirePluginInstallationOptions {
  readonly store?: PluginInstallationStore;
  readonly version?: string;
}

/** Require that an operator has installed the static plugin entry. */
export async function requireInstalled(
  pluginId: string,
  options: RequirePluginInstallationOptions = {}
): Promise<PluginInstallationRecord> {
  const normalizedId = boundedPluginId(pluginId);
  if (!pluginRegistry.get(normalizedId)) {
    throw new PluginError("CONFIGURATION_ERROR", `未注册的插件：${normalizedId}`, {
      path: "pluginId",
    });
  }
  const record = await (options.store || (await getPluginInstallationStore())).get(normalizedId);
  if (!record || !INSTALLED_STATUSES.includes(record.status)) {
    throw new PluginError(
      "CAPABILITY_UNAVAILABLE",
      `插件 ${normalizedId} 尚未安装，不能调用`,
      { path: "installation.status" }
    );
  }
  if (options.version && record.pluginVersion !== options.version) {
    throw new PluginError(
      "CAPABILITY_UNAVAILABLE",
      `插件 ${normalizedId} 需要安装版本 ${options.version}`,
      { path: "installation.pluginVersion" }
    );
  }
  return record;
}

/** Require installation plus an explicit enabled state before execution. */
export async function requireUsable(
  pluginId: string,
  options: RequirePluginInstallationOptions = {}
): Promise<PluginInstallationRecord> {
  const record = await requireInstalled(pluginId, options);
  if (record.status !== "enabled") {
    throw new PluginError(
      "CAPABILITY_UNAVAILABLE",
      `插件 ${pluginId} 尚未启用，不能调用`,
      { path: "installation.status" }
    );
  }
  return record;
}

export const pluginInstallationInternals = Object.freeze({
  applyMutation,
  normalizeMutation,
  canTransition,
});
