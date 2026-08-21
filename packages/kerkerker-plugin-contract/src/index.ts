/**
 * Public, runtime-neutral v1 plugin contract.
 *
 * This package deliberately contains only JSON-compatible data contracts and
 * small validation helpers. It must remain usable by a remote sidecar and by
 * an independently published adapter without importing the host application.
 */

export const PLUGIN_CONTRACT_VERSION = "1.0.0" as const;

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
