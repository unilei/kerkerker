import type { Db } from "mongodb";
import { COLLECTIONS } from "@/lib/constants/db";

/** Values written to audit records when a field may contain credentials. */
export const REDACTED_VALUE = "[REDACTED]" as const;
export const TRUNCATED_VALUE = "[TRUNCATED]" as const;

export const PLUGIN_POLICY_STATUSES = [
  "pending",
  "approved",
  "suspended",
  "revoked",
  "rejected",
] as const;
export type PluginPolicyStatus = (typeof PLUGIN_POLICY_STATUSES)[number];

export const COMPLIANCE_ENFORCEMENT_MODES = ["audit", "enforce"] as const;
export type ComplianceEnforcementMode = (typeof COMPLIANCE_ENFORCEMENT_MODES)[number];

export const TAKEDOWN_STATUSES = [
  "active",
  "resolved",
  "rejected",
  "expired",
] as const;
export type TakedownStatus = (typeof TAKEDOWN_STATUSES)[number];

export type AuditActorType = "admin" | "system" | "plugin" | "anonymous";

export interface AuditActor {
  readonly type: AuditActorType;
  /** A stable operator/service identifier, never a session token. */
  readonly id?: string;
  /** Optional display label. It is bounded and redacted before storage. */
  readonly label?: string;
}

export interface AuditActorDoc {
  type: AuditActorType;
  id?: string;
  label?: string;
}

export interface PluginContact {
  readonly name?: string;
  readonly email?: string;
  readonly url?: string;
}

export interface PluginPolicyDoc {
  _id?: unknown;
  plugin_id: string;
  plugin_version: string;
  status: PluginPolicyStatus;
  enabled: boolean;
  enforcement_mode: ComplianceEnforcementMode;
  owner?: string;
  authorization_ref?: string;
  license?: string;
  legal_basis: string;
  terms_url?: string;
  data_purpose?: string | string[];
  content_scope: string | string[];
  regions: string[];
  data_classification: string;
  retention_days?: number;
  correction_contact?: PluginContact | string;
  takedown_contact?: PluginContact | string;
  approved_by?: AuditActorDoc;
  approved_at?: string;
  reason?: string;
  created_at: string;
  updated_at: string;
}

export interface PluginPolicyInput {
  readonly pluginId: string;
  readonly pluginVersion?: string;
  readonly status?: PluginPolicyStatus;
  readonly enabled?: boolean;
  readonly enforcementMode?: ComplianceEnforcementMode;
  readonly owner?: string;
  readonly authorizationRef?: string;
  readonly license?: string;
  readonly legalBasis?: string;
  readonly termsUrl?: string;
  readonly dataPurpose?: string | readonly string[];
  readonly contentScope?: string | readonly string[];
  readonly regions?: readonly string[];
  readonly dataClassification?: string;
  readonly retentionDays?: number;
  readonly correctionContact?: PluginContact | string;
  readonly takedownContact?: PluginContact | string;
  readonly approvedBy?: AuditActor;
  readonly approvedAt?: string;
  readonly reason?: string;
}

export interface AuditTarget {
  readonly type: string;
  readonly id?: string;
  readonly contentId?: string;
  readonly providerId?: string;
  readonly pluginId?: string;
  readonly resourceId?: string;
}

export interface AuditTargetDoc {
  type: string;
  id?: string;
  content_id?: string;
  provider_id?: string;
  plugin_id?: string;
  resource_id?: string;
}

export interface AuditEventDoc {
  _id?: unknown;
  event_id: string;
  idempotency_key: string;
  actor: AuditActorDoc;
  action: string;
  target?: AuditTargetDoc;
  plugin_id?: string;
  plugin_version?: string;
  capability?: string;
  profile?: string;
  region?: string;
  content_id?: string;
  provider_id?: string;
  request_id?: string;
  run_id?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  created_at: string;
  expires_at?: Date;
}

export interface AuditEventInput {
  readonly idempotencyKey?: string;
  readonly actor?: AuditActor;
  readonly action: string;
  readonly target?: AuditTarget;
  readonly pluginId?: string;
  readonly pluginVersion?: string;
  readonly capability?: string;
  readonly profile?: string;
  readonly region?: string;
  readonly contentId?: string;
  readonly providerId?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly reason?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly metadata?: unknown;
  readonly createdAt?: string;
  readonly expiresAt?: string | Date;
}

export interface TakedownTarget {
  readonly type: "content" | "resource" | "plugin" | "provider" | "image" | "playback" | "danmu" | string;
  readonly id?: string;
  readonly contentId?: string;
  readonly providerId?: string;
  readonly pluginId?: string;
  readonly resourceId?: string;
  readonly externalId?: string;
}

export interface TakedownTargetDoc {
  type: string;
  id?: string;
  content_id?: string;
  provider_id?: string;
  plugin_id?: string;
  resource_id?: string;
  external_id?: string;
}

export interface TakedownRecordDoc {
  _id?: unknown;
  takedown_id: string;
  idempotency_key: string;
  target: TakedownTargetDoc;
  status: TakedownStatus;
  reason_code: string;
  reason: string;
  evidence?: unknown;
  requested_by: AuditActorDoc;
  resolved_by?: AuditActorDoc;
  resolution_reason?: string;
  effective_at: string;
  /** BSON Date so MongoDB's TTL monitor can expire it at the requested time. */
  expires_at?: Date;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TakedownInput {
  readonly idempotencyKey?: string;
  readonly target: TakedownTarget;
  readonly reasonCode: string;
  readonly reason: string;
  readonly evidence?: unknown;
  readonly requestedBy?: AuditActor;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
}

export interface TakedownResolutionInput {
  readonly status: Extract<TakedownStatus, "resolved" | "rejected" | "expired">;
  readonly resolvedBy?: AuditActor;
  readonly resolutionReason?: string;
}

export interface PluginPolicyLookup {
  readonly pluginId: string;
  readonly pluginVersion?: string;
}

export interface PluginPolicyQuery {
  readonly pluginId?: string;
  readonly status?: PluginPolicyStatus | readonly PluginPolicyStatus[];
  readonly enabled?: boolean;
  readonly limit?: number;
}

export type PolicyDecisionReason =
  | "approved"
  | "registered-legacy"
  | "missing-policy"
  | "plugin-not-registered"
  | "policy-disabled"
  | "policy-status"
  | "policy-incomplete"
  | "region-not-allowed"
  | "takedown-active";

export interface PluginPolicyDecision {
  readonly allowed: boolean;
  /** True when the same decision would be denied in enforce mode. */
  readonly wouldDeny: boolean;
  readonly mode: ComplianceEnforcementMode;
  readonly reason: PolicyDecisionReason;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly policy?: PluginPolicyDoc;
  readonly takedown?: TakedownRecordDoc;
}

export interface AuditEventQuery {
  readonly action?: string;
  readonly pluginId?: string;
  readonly contentId?: string;
  readonly providerId?: string;
  readonly runId?: string;
  readonly actorId?: string;
  readonly limit?: number;
  readonly before?: string;
}

export interface TakedownQuery {
  readonly status?: TakedownStatus | readonly TakedownStatus[];
  readonly contentId?: string;
  readonly providerId?: string;
  readonly pluginId?: string;
  readonly resourceId?: string;
  readonly limit?: number;
  readonly before?: string;
  readonly includeExpired?: boolean;
}

export interface ComplianceIndexTarget {
  createIndex(
    keys: Record<string, 1 | -1>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

/**
 * Idempotent index setup kept separate from the repository so `lib/db.ts` can
 * initialize the collections without importing the database-bound module.
 */
export async function ensureComplianceIndexes(db: Db): Promise<void> {
  const policies = db.collection(COLLECTIONS.PLUGIN_POLICIES);
  await policies.createIndex(
    { plugin_id: 1, plugin_version: 1 },
    { unique: true, name: "plugin_policy_identity" }
  );
  await policies.createIndex(
    { status: 1, enabled: 1, updated_at: -1 },
    { name: "plugin_policy_status" }
  );
  await policies.createIndex(
    { regions: 1, updated_at: -1 },
    { name: "plugin_policy_regions" }
  );

  const audits = db.collection(COLLECTIONS.AUDIT_EVENTS);
  await audits.createIndex(
    { event_id: 1 },
    { unique: true, name: "audit_event_identity" }
  );
  await audits.createIndex(
    { idempotency_key: 1 },
    { unique: true, name: "audit_event_idempotency" }
  );
  await audits.createIndex(
    { created_at: -1 },
    { name: "audit_event_created" }
  );
  await audits.createIndex(
    { "actor.type": 1, "actor.id": 1, created_at: -1 },
    { name: "audit_event_actor" }
  );
  await audits.createIndex(
    { "target.type": 1, "target.id": 1, created_at: -1 },
    { name: "audit_event_target" }
  );
  await audits.createIndex(
    { expires_at: 1 },
    { expireAfterSeconds: 0, name: "audit_event_retention" }
  );

  const takedowns = db.collection(COLLECTIONS.TAKEDOWN_RECORDS);
  await takedowns.createIndex(
    { takedown_id: 1 },
    { unique: true, name: "takedown_identity" }
  );
  await takedowns.createIndex(
    { idempotency_key: 1 },
    { unique: true, name: "takedown_idempotency" }
  );
  await takedowns.createIndex(
    { status: 1, created_at: -1 },
    { name: "takedown_status" }
  );
  await takedowns.createIndex(
    { "target.content_id": 1, status: 1, updated_at: -1 },
    { name: "takedown_content" }
  );
  await takedowns.createIndex(
    { "target.plugin_id": 1, status: 1, updated_at: -1 },
    { name: "takedown_plugin" }
  );
  await takedowns.createIndex(
    { "target.provider_id": 1, status: 1, updated_at: -1 },
    { name: "takedown_provider" }
  );
  await takedowns.createIndex(
    { expires_at: 1 },
    { expireAfterSeconds: 0, name: "takedown_expiry" }
  );
}

const SECRET_KEY_PATTERN =
  /(?:password|passwd|token|secret|api[-_]?key|authorization|cookie|set[-_]?cookie|credential|private[-_]?key|access[-_]?code|share[-_]?code|extract[-_]?code|signature|signed|jwt|session)/i;
const SENSITIVE_URL_PARAMETER_PATTERN =
  /(?:token|key|secret|password|auth|code|signature|sig|credential|session|cookie)/i;
const SECRET_VALUE_PATTERN = /^(?:bearer\s+\S+|basic\s+\S+|[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})$/i;
const MAX_REDACT_DEPTH = 8;
const MAX_REDACT_KEYS = 100;
const MAX_REDACT_ARRAY = 100;
const MAX_REDACT_STRING = 4_000;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMETER_PATTERN.test(key)) {
        url.searchParams.set(key, REDACTED_VALUE);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/** Clone an arbitrary snapshot while removing credentials and bounding size. */
export function redactSensitive(value: unknown, depth = 0, keyHint?: string): unknown {
  if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) return REDACTED_VALUE;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERN.test(value.trim())) return REDACTED_VALUE;
    const redacted = /^https?:\/\//i.test(value) ? redactUrl(value) : value;
    return redacted.length > MAX_REDACT_STRING
      ? `${redacted.slice(0, MAX_REDACT_STRING)}${TRUNCATED_VALUE}`
      : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_REDACT_DEPTH) return TRUNCATED_VALUE;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_REDACT_ARRAY)
      .map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).slice(0, MAX_REDACT_KEYS)) {
      output[key] = redactSensitive(source[key], depth + 1, key);
    }
    if (Object.keys(source).length > MAX_REDACT_KEYS) output.__truncated = true;
    return output;
  }
  return String(value);
}

export function normalizeComplianceMode(
  value: unknown,
  fallback: ComplianceEnforcementMode = "audit"
): ComplianceEnforcementMode {
  return value === "enforce" || value === "audit" ? value : fallback;
}

export function complianceModeFromEnvironment(): ComplianceEnforcementMode {
  return normalizeComplianceMode(process.env.KERKERKER_COMPLIANCE_MODE, "audit");
}
