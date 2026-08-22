/**
 * Public, runtime-neutral v1 plugin contract.
 *
 * This package deliberately contains only JSON-compatible data contracts and
 * small validation helpers. It must remain usable by a remote sidecar and by
 * an independently published adapter without importing the host application.
 */

export const PLUGIN_CONTRACT_VERSION = "1.0.0" as const;

export const PLUGIN_JOB_EVENT_SCHEMA = "kerkerker.plugin-job.v1" as const;
export const PLUGIN_JOB_EVENT_KINDS = ["started", "progress", "finished"] as const;
export const PLUGIN_JOB_EVENT_STATUSES = ["running", "succeeded", "partial", "failed"] as const;

export type PluginJobEventKind = (typeof PLUGIN_JOB_EVENT_KINDS)[number];
export type PluginJobEventStatus = (typeof PLUGIN_JOB_EVENT_STATUSES)[number];

export interface PluginJobEventMetadata {
  readonly run_id: string;
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly profile_id: string;
  readonly config_version: string;
  readonly actor: string;
  readonly attempt: number;
}

export interface PluginJobEventProgress {
  readonly total: number;
  readonly processed: number;
  readonly created: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface PluginJobEvent {
  readonly schema: typeof PLUGIN_JOB_EVENT_SCHEMA;
  readonly event_id: string;
  readonly sequence: number;
  readonly kind: PluginJobEventKind;
  readonly occurred_at: string;
  readonly metadata: PluginJobEventMetadata;
  readonly status: PluginJobEventStatus;
  readonly progress: PluginJobEventProgress;
  readonly error?: { readonly code?: string; readonly message: string };
}

const JOB_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const JOB_PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const RFC3339_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isExactRecord(
  value: unknown,
  allowedKeys: readonly string[]
): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function isContractText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Array.from(value).length <= maxLength &&
    !/\p{Cc}/u.test(value);
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

/** Strict RFC3339 validation aligned with Go's time.RFC3339Nano parser. */
export function isRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (
    month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

/** Runtime guard for semantic rules that JSON Schema cannot express portably. */
export function isPluginJobEvent(value: unknown): value is PluginJobEvent {
  if (!isExactRecord(value, [
    "schema", "event_id", "sequence", "kind", "occurred_at",
    "metadata", "status", "progress", "error",
  ])) return false;
  if (
    value.schema !== PLUGIN_JOB_EVENT_SCHEMA ||
    !PLUGIN_JOB_EVENT_KINDS.includes(value.kind as PluginJobEventKind) ||
    !PLUGIN_JOB_EVENT_STATUSES.includes(value.status as PluginJobEventStatus) ||
    !isSafeInteger(value.sequence) ||
    !isRfc3339DateTime(value.occurred_at)
  ) return false;

  const metadata = value.metadata;
  if (!isExactRecord(metadata, [
    "run_id", "plugin_id", "plugin_version", "profile_id",
    "config_version", "actor", "attempt",
  ])) return false;
  if (
    !isContractText(metadata.run_id, 200) || !JOB_RUN_ID_PATTERN.test(metadata.run_id) ||
    !isContractText(metadata.plugin_id, 100) || !JOB_PLUGIN_ID_PATTERN.test(metadata.plugin_id) ||
    !isContractText(metadata.plugin_version, 100) ||
    !isContractText(metadata.profile_id, 100) ||
    !isContractText(metadata.config_version, 100) ||
    !isContractText(metadata.actor, 200) ||
    !isSafeInteger(metadata.attempt, 1) ||
    value.event_id !== `${metadata.run_id}:${value.sequence}` ||
    !isContractText(value.event_id, 240)
  ) return false;

  const progress = value.progress;
  if (!isExactRecord(progress, ["total", "processed", "created", "failed", "skipped"])) return false;
  if (
    !isSafeInteger(progress.total) || !isSafeInteger(progress.processed) ||
    !isSafeInteger(progress.created) || !isSafeInteger(progress.failed) ||
    !isSafeInteger(progress.skipped) || progress.processed > progress.total
  ) return false;
  const categorized = progress.created + progress.failed + progress.skipped;
  if (!Number.isSafeInteger(categorized) || categorized !== progress.processed) return false;

  if (value.error !== undefined) {
    if (!isExactRecord(value.error, ["code", "message"])) return false;
    if (value.error.code !== undefined && !isContractText(value.error.code, 100)) return false;
    if (!isContractText(value.error.message, 2_000)) return false;
  }
  if (value.kind === "started") {
    return value.sequence === 0 && value.status === "running" && value.error === undefined;
  }
  if (value.sequence === 0) return false;
  if (value.kind === "progress") return value.status === "running" && value.error === undefined;
  if (value.status === "running") return false;
  if (value.status === "failed") return value.error !== undefined;
  if (value.status === "succeeded") return value.error === undefined;
  return true;
}

export type PluginContractVersion =
  | `${number}.${number}`
  | `${number}.${number}.${number}`;

export type PluginCapabilityId =
  | "content.catalog"
  | "content.calendar"
  | "content.detail"
  | "content.search"
  | "resource.cloud-drive"
  | "resource.playback"
  | "interaction.danmu"
  | "asset.image"
  | "recommendation";

export const PLUGIN_CAPABILITIES: readonly PluginCapabilityId[] = [
  "content.catalog",
  "content.calendar",
  "content.detail",
  "content.search",
  "resource.cloud-drive",
  "resource.playback",
  "interaction.danmu",
  "asset.image",
  "recommendation",
] as const;

export type PluginRuntimeMode = "built-in" | "package" | "remote";

/** Optional remote runtime health probe configuration. */
export interface PluginRuntimeHealth {
  /** Absolute path on the declared remote origin, for example `/healthz`. */
  readonly path: string;
  /** Host-side probe deadline in milliseconds. */
  readonly timeoutMs?: number;
}

/** Optional remote runtime authentication declaration. Values are host secrets. */
export interface PluginRuntimeAuth {
  /** `bearer` uses Authorization; `header` uses the declared header name. */
  readonly type: "bearer" | "header";
  /** Name of a secret declared in `permissions.secrets`; never a secret value. */
  readonly secret: string;
  readonly header?: string;
}

export interface PluginRuntime {
  readonly mode: PluginRuntimeMode;
  readonly entry: string;
  /** Supported wire contract versions for remote protocol negotiation. */
  readonly protocolVersions?: readonly PluginContractVersion[];
  readonly health?: PluginRuntimeHealth;
  readonly auth?: PluginRuntimeAuth;
}

export interface PluginCapabilityDeclaration {
  readonly id: PluginCapabilityId;
  readonly version: string;
  readonly features?: readonly ("search" | "incremental" | "availability")[];
}

export interface PluginConfigField {
  readonly key: string;
  readonly type: "string" | "number" | "boolean" | "url" | "secret" | "select";
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly options?: readonly string[];
}

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly contractVersion: PluginContractVersion;
  readonly runtime: PluginRuntime;
  readonly capabilities: readonly PluginCapabilityDeclaration[];
  readonly locales: readonly string[];
  readonly config: {
    readonly version: string;
    readonly fields: readonly PluginConfigField[];
  };
  readonly compliance: {
    readonly legalBasis: string;
    readonly termsUrl?: string;
    readonly owner?: string;
    readonly authorizationRef?: string;
    readonly dataPurpose?: string | readonly string[];
    readonly retentionDays?: number;
    readonly correctionContact?: PluginComplianceContact | string;
    readonly takedownContact?: PluginComplianceContact | string;
    readonly contentScope: string | readonly string[];
    readonly regions: readonly string[];
    readonly dataClassification: string;
  };
  readonly permissions: {
    readonly networkHosts: readonly string[];
    readonly secrets: readonly string[];
    readonly storage: "none" | "ephemeral" | "namespaced" | "persistent";
  };
}

export interface PluginComplianceContact {
  readonly name?: string;
  readonly email?: string;
  readonly url?: string;
}

export interface ExternalReference {
  readonly providerId: string;
  readonly externalId: string;
  readonly canonicalUrl?: string;
  readonly verifiedAt?: string;
}

export interface HostContentReference {
  readonly contentId: string;
  readonly externalRefs: readonly ExternalReference[];
}

export interface PluginRequestContext {
  readonly requestId: string;
  readonly profile: string;
  readonly locale: string;
  readonly region: string;
  readonly deadline: string;
  readonly contractVersion: PluginContractVersion;
}

export interface PluginErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
    readonly retryable?: boolean;
    readonly details?: Record<string, unknown>;
  };
}

export interface PluginPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly hasMore?: boolean;
  readonly total?: number;
  readonly consistency?: PluginPageConsistency;
}

export interface PluginPageConsistency {
  readonly rawCount: number;
  readonly rawIds: readonly string[];
  readonly fingerprint: string;
}

export function isPluginCapabilityId(value: unknown): value is PluginCapabilityId {
  return typeof value === "string" &&
    (PLUGIN_CAPABILITIES as readonly string[]).includes(value);
}

export function isPluginContractVersion(value: unknown): value is PluginContractVersion {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(value);
}

export function isPluginErrorEnvelope(value: unknown): value is PluginErrorEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return typeof code === "string" && code.length > 0 &&
    typeof message === "string" && message.length > 0;
}
