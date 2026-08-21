import { createHash, randomUUID } from "node:crypto";
import type { Collection, Db, Filter, OptionalId } from "mongodb";

import { COLLECTIONS } from "@/lib/constants/db";
import { getDatabase } from "@/lib/db";
import { pluginRegistry } from "@/lib/plugins/builtin";
import {
  PLUGIN_POLICY_STATUSES,
  TAKEDOWN_STATUSES,
  complianceModeFromEnvironment,
  normalizeComplianceMode,
  redactSensitive,
  type AuditActor,
  type AuditActorDoc,
  type AuditEventDoc,
  type AuditEventInput,
  type AuditEventQuery,
  type AuditTarget,
  type AuditTargetDoc,
  type ComplianceEnforcementMode,
  type PluginContact,
  type PluginPolicyDecision,
  type PluginPolicyDoc,
  type PluginPolicyInput,
  type PluginPolicyLookup,
  type PluginPolicyQuery,
  type PluginPolicyStatus,
  type TakedownInput,
  type TakedownQuery,
  type TakedownRecordDoc,
  type TakedownResolutionInput,
  type TakedownStatus,
  type TakedownTarget,
  type TakedownTargetDoc,
} from "@/lib/compliance-types";

export * from "@/lib/compliance-types";

const PLUGIN_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const PROVIDER_ID_PATTERN = PLUGIN_ID_PATTERN;
const LOCALE_REGION_PATTERN = /^(?:[A-Z]{2}|GLOBAL)$/;
const CONTENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 2_000;
const MAX_CONTACT_LENGTH = 500;
const DEFAULT_PLUGIN_VERSION = "current";
const DEFAULT_AUDIT_RETENTION_DAYS = 365;

export class ComplianceValidationError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceValidationError";
  }
}

export class ComplianceIdempotencyConflictError extends Error {
  constructor(message = "幂等键已经绑定到不同的合规记录") {
    super(message);
    this.name = "ComplianceIdempotencyConflictError";
  }
}

export interface ComplianceStore {
  getPluginPolicy(
    pluginId: string,
    pluginVersion: string
  ): Promise<PluginPolicyDoc | null>;
  listPluginPolicies(query: PluginPolicyQuery): Promise<PluginPolicyDoc[]>;
  upsertPluginPolicy(document: PluginPolicyDoc): Promise<PluginPolicyDoc>;
  findAuditByIdempotencyKey(key: string): Promise<AuditEventDoc | null>;
  insertAuditEvent(document: AuditEventDoc): Promise<AuditEventDoc>;
  listAuditEvents(query: AuditEventQuery): Promise<AuditEventDoc[]>;
  findTakedownByIdempotencyKey(key: string): Promise<TakedownRecordDoc | null>;
  insertTakedown(document: TakedownRecordDoc): Promise<TakedownRecordDoc>;
  updateTakedown(
    takedownId: string,
    patch: Partial<TakedownRecordDoc>
  ): Promise<TakedownRecordDoc | null>;
  getTakedownById(takedownId: string): Promise<TakedownRecordDoc | null>;
  listTakedowns(query: TakedownQuery): Promise<TakedownRecordDoc[]>;
  findActiveTakedown(target: {
    contentId?: string;
    providerId?: string;
    pluginId?: string;
    resourceId?: string;
  }): Promise<TakedownRecordDoc | null>;
}

export interface ComplianceRepository {
  getPluginPolicy(lookup: PluginPolicyLookup): Promise<PluginPolicyDoc | null>;
  listPluginPolicies(query?: PluginPolicyQuery): Promise<PluginPolicyDoc[]>;
  upsertPluginPolicy(input: PluginPolicyInput): Promise<PluginPolicyDoc>;
  ensurePluginAllowed(options: EnsurePluginAllowedOptions): Promise<PluginPolicyDecision>;
  recordAudit(input: AuditEventInput): Promise<AuditEventDoc>;
  listAuditEvents(query?: AuditEventQuery): Promise<AuditEventDoc[]>;
  createTakedown(input: TakedownInput): Promise<TakedownRecordDoc>;
  resolveTakedown(
    takedownId: string,
    input: TakedownResolutionInput
  ): Promise<TakedownRecordDoc | null>;
  listTakedowns(query?: TakedownQuery): Promise<TakedownRecordDoc[]>;
  getActiveTakedown(target: {
    contentId?: string;
    providerId?: string;
    pluginId?: string;
    resourceId?: string;
  }): Promise<TakedownRecordDoc | null>;
}

export interface EnsurePluginAllowedOptions extends PluginPolicyLookup {
  readonly capability?: string;
  readonly profile?: string;
  readonly region?: string;
  readonly contentId?: string;
  /** Override the static registry check in tests or an isolated host. */
  readonly registered?: boolean;
  /** `audit` records a would-deny decision but preserves compatibility. */
  readonly mode?: ComplianceEnforcementMode;
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000;
}

function boundedString(value: unknown, field: string, max = MAX_ID_LENGTH): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw new ComplianceValidationError(`${field} 格式无效`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  max = MAX_ID_LENGTH
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedString(value, field, max);
}

function assertPluginId(value: unknown, field = "pluginId"): string {
  const normalized = boundedString(value, field);
  if (!PLUGIN_ID_PATTERN.test(normalized)) {
    throw new ComplianceValidationError(`${field} 格式无效`);
  }
  return normalized;
}

function assertProviderId(value: unknown, field = "providerId"): string {
  const normalized = boundedString(value, field);
  if (!PROVIDER_ID_PATTERN.test(normalized)) {
    throw new ComplianceValidationError(`${field} 格式无效`);
  }
  return normalized;
}

function optionalContentId(value: unknown, field = "contentId"): string | undefined {
  const normalized = optionalString(value, field);
  if (normalized && !CONTENT_ID_PATTERN.test(normalized)) {
    throw new ComplianceValidationError(`${field} 必须是有效 UUID`);
  }
  return normalized;
}

function normalizeVersion(value: unknown): string {
  return optionalString(value, "pluginVersion", 100) || DEFAULT_PLUGIN_VERSION;
}

function normalizeReason(value: unknown, field = "reason"): string {
  return boundedString(value, field, MAX_REASON_LENGTH);
}

function normalizeTimestamp(value: unknown, field: string, fallback = new Date()): string {
  if (value === undefined || value === null || value === "") return fallback.toISOString();
  const stringValue = boundedString(value, field, 100);
  const parsed = new Date(stringValue);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ComplianceValidationError(`${field} 必须是有效时间`);
  }
  return parsed.toISOString();
}

function normalizeDate(value: string | Date | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(boundedString(value, field, 100));
  if (!Number.isFinite(parsed.getTime())) throw new ComplianceValidationError(`${field} 必须是有效时间`);
  return parsed;
}

function normalizeRegions(value: readonly string[] | undefined): string[] {
  const regions = value?.length ? [...value] : ["GLOBAL"];
  const normalized = [...new Set(regions.map((region) => String(region).trim().toUpperCase()))];
  if (normalized.length === 0 || normalized.some((region) => !LOCALE_REGION_PATTERN.test(region))) {
    throw new ComplianceValidationError("regions 必须包含 ISO 区域码或 GLOBAL");
  }
  return normalized;
}

function normalizeTextList(
  value: string | readonly string[] | undefined,
  field: string,
  fallback?: string
): string | string[] | undefined {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "string") return boundedString(value, field, MAX_REASON_LENGTH);
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ComplianceValidationError(`${field} 格式无效`);
  }
  return value.map((item, index) => boundedString(item, `${field}[${index}]`, MAX_REASON_LENGTH));
}

function normalizeHttpsUrl(value: unknown, field: string): string | undefined {
  const normalized = optionalString(value, field, 2_000);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error("unsafe URL");
    }
    return parsed.toString();
  } catch {
    throw new ComplianceValidationError(`${field} 必须是无凭据的 HTTPS URL`);
  }
}

function normalizeContact(value: PluginContact | string | undefined, field: string): PluginContact | string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return boundedString(value, field, MAX_CONTACT_LENGTH);
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ComplianceValidationError(`${field} 格式无效`);
  }
  const contact = value as PluginContact;
  const name = optionalString(contact.name, `${field}.name`, MAX_CONTACT_LENGTH);
  const email = optionalString(contact.email, `${field}.email`, MAX_CONTACT_LENGTH);
  const url = normalizeHttpsUrl(contact.url, `${field}.url`);
  if (!name && !email && !url) throw new ComplianceValidationError(`${field} 不能为空`);
  return { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(url ? { url } : {}) };
}

function normalizeActor(value: AuditActor | undefined, fallbackType: AuditActor["type"]): AuditActorDoc {
  const actor = value || { type: fallbackType };
  if (!actor || !["admin", "system", "plugin", "anonymous"].includes(actor.type)) {
    throw new ComplianceValidationError("actor.type 格式无效");
  }
  const id = optionalString(actor.id, "actor.id", MAX_ID_LENGTH);
  const label = optionalString(actor.label, "actor.label", MAX_CONTACT_LENGTH);
  return {
    type: actor.type,
    ...(id ? { id: String(redactSensitive(id)) } : {}),
    ...(label ? { label: String(redactSensitive(label)) } : {}),
  };
}

function normalizeTarget(target: AuditTarget | undefined): AuditTargetDoc | undefined {
  if (!target) return undefined;
  const type = boundedString(target.type, "target.type", 100);
  return {
    type,
    ...(optionalString(target.id, "target.id") ? { id: optionalString(target.id, "target.id") } : {}),
    ...(optionalContentId(target.contentId) ? { content_id: optionalContentId(target.contentId) } : {}),
    ...(target.providerId ? { provider_id: assertProviderId(target.providerId) } : {}),
    ...(target.pluginId ? { plugin_id: assertPluginId(target.pluginId) } : {}),
    ...(optionalString(target.resourceId, "target.resourceId") ? { resource_id: optionalString(target.resourceId, "target.resourceId") } : {}),
  };
}

function normalizeTakedownTarget(target: TakedownTarget): TakedownTargetDoc {
  const normalizedType = boundedString(target.type, "target.type", 100);
  const id = optionalString(target.id, "target.id");
  const contentId = optionalContentId(target.contentId);
  const providerId = target.providerId ? assertProviderId(target.providerId) : undefined;
  const pluginId = target.pluginId ? assertPluginId(target.pluginId) : undefined;
  const resourceId = optionalString(target.resourceId, "target.resourceId");
  const externalId = optionalString(target.externalId, "target.externalId", 500);
  if (!id && !contentId && !providerId && !pluginId && !resourceId && !externalId) {
    throw new ComplianceValidationError("下架目标至少需要一个稳定 ID");
  }
  return {
    type: normalizedType,
    ...(id ? { id } : {}),
    ...(contentId ? { content_id: contentId } : {}),
    ...(providerId ? { provider_id: providerId } : {}),
    ...(pluginId ? { plugin_id: pluginId } : {}),
    ...(resourceId ? { resource_id: resourceId } : {}),
    ...(externalId ? { external_id: externalId } : {}),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(redactSensitive(value))).digest("hex");
}

function generatedIdempotencyKey(prefix: string, value: unknown): string {
  return `${prefix}:${fingerprint(value)}`;
}

function toDateOrUndefined(value: string | Date | undefined): Date | undefined {
  const normalized = normalizeDate(value, "expiresAt");
  return normalized;
}

function policyDocFromInput(input: PluginPolicyInput, existing?: PluginPolicyDoc): PluginPolicyDoc {
  const pluginId = assertPluginId(input.pluginId);
  const pluginVersion = normalizeVersion(input.pluginVersion ?? existing?.plugin_version);
  const now = new Date().toISOString();
  const status = input.status ?? existing?.status ?? "pending";
  if (!PLUGIN_POLICY_STATUSES.includes(status)) {
    throw new ComplianceValidationError("status 格式无效");
  }
  const enforcementMode = normalizeComplianceMode(
    input.enforcementMode ?? existing?.enforcement_mode,
    "audit"
  );
  const legalBasis = boundedString(input.legalBasis ?? existing?.legal_basis ?? "operator-review-required", "legalBasis", MAX_REASON_LENGTH);
  const contentScope = normalizeTextList(
    input.contentScope ?? existing?.content_scope,
    "contentScope",
    "operator-review-required"
  )!;
  const dataClassification = boundedString(
    input.dataClassification ?? existing?.data_classification ?? "restricted",
    "dataClassification",
    100
  );
  const regions = normalizeRegions(input.regions ?? existing?.regions);
  const retentionDays = input.retentionDays ?? existing?.retention_days;
  if (retentionDays !== undefined && (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650)) {
    throw new ComplianceValidationError("retentionDays 必须是 1 至 3650 的整数");
  }
  const approvedBy = input.approvedBy
    ? normalizeActor(input.approvedBy, "admin")
    : existing?.approved_by;
  const approvedAt = input.approvedAt
    ? normalizeTimestamp(input.approvedAt, "approvedAt")
    : existing?.approved_at;
  return {
    ...(existing?._id ? { _id: existing._id } : {}),
    plugin_id: pluginId,
    plugin_version: pluginVersion,
    status,
    enabled: input.enabled ?? existing?.enabled ?? false,
    enforcement_mode: enforcementMode,
    ...(optionalString(input.owner ?? existing?.owner, "owner", MAX_CONTACT_LENGTH)
      ? { owner: optionalString(input.owner ?? existing?.owner, "owner", MAX_CONTACT_LENGTH) }
      : {}),
    ...(optionalString(input.authorizationRef ?? existing?.authorization_ref, "authorizationRef", MAX_REASON_LENGTH)
      ? { authorization_ref: optionalString(input.authorizationRef ?? existing?.authorization_ref, "authorizationRef", MAX_REASON_LENGTH) }
      : {}),
    ...(optionalString(input.license ?? existing?.license, "license", MAX_REASON_LENGTH)
      ? { license: optionalString(input.license ?? existing?.license, "license", MAX_REASON_LENGTH) }
      : {}),
    legal_basis: legalBasis,
    ...(normalizeHttpsUrl(input.termsUrl ?? existing?.terms_url, "termsUrl")
      ? { terms_url: normalizeHttpsUrl(input.termsUrl ?? existing?.terms_url, "termsUrl") }
      : {}),
    ...(normalizeTextList(input.dataPurpose ?? existing?.data_purpose, "dataPurpose")
      ? { data_purpose: normalizeTextList(input.dataPurpose ?? existing?.data_purpose, "dataPurpose") }
      : {}),
    content_scope: contentScope,
    regions,
    data_classification: dataClassification,
    ...(retentionDays !== undefined ? { retention_days: retentionDays } : {}),
    ...(normalizeContact(input.correctionContact ?? existing?.correction_contact, "correctionContact")
      ? { correction_contact: normalizeContact(input.correctionContact ?? existing?.correction_contact, "correctionContact") }
      : {}),
    ...(normalizeContact(input.takedownContact ?? existing?.takedown_contact, "takedownContact")
      ? { takedown_contact: normalizeContact(input.takedownContact ?? existing?.takedown_contact, "takedownContact") }
      : {}),
    ...(approvedBy ? { approved_by: approvedBy } : {}),
    ...(approvedAt ? { approved_at: approvedAt } : {}),
    ...(optionalString(input.reason ?? existing?.reason, "reason", MAX_REASON_LENGTH)
      ? { reason: optionalString(input.reason ?? existing?.reason, "reason", MAX_REASON_LENGTH) }
      : {}),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
}

function normalizeAuditInput(input: AuditEventInput): AuditEventDoc {
  const action = boundedString(input.action, "action", 128);
  if (!/^[a-z][a-z0-9_.:-]{1,127}$/.test(action)) {
    throw new ComplianceValidationError("action 格式无效");
  }
  const actor = normalizeActor(input.actor, "system");
  const target = normalizeTarget(input.target);
  const requestId = optionalString(input.requestId, "requestId");
  const runId = optionalString(input.runId, "runId");
  const pluginId = input.pluginId ? assertPluginId(input.pluginId) : undefined;
  const providerId = input.providerId ? assertProviderId(input.providerId) : undefined;
  const contentId = optionalContentId(input.contentId);
  const idempotencyKey = input.idempotencyKey
    ? boundedString(input.idempotencyKey, "idempotencyKey", 300)
    : requestId
      ? generatedIdempotencyKey("audit", {
          requestId,
          action,
          target,
          pluginId,
          contentId,
          providerId,
        })
      : randomUUID();
  const createdAt = normalizeTimestamp(input.createdAt, "createdAt");
  const expiresAt = toDateOrUndefined(
    input.expiresAt ?? new Date(Date.parse(createdAt) + DEFAULT_AUDIT_RETENTION_DAYS * 86_400_000)
  );
  return {
    event_id: randomUUID(),
    idempotency_key: idempotencyKey,
    actor,
    action,
    ...(target ? { target } : {}),
    ...(pluginId ? { plugin_id: pluginId } : {}),
    ...(input.pluginVersion ? { plugin_version: boundedString(input.pluginVersion, "pluginVersion", 100) } : {}),
    ...(input.capability ? { capability: boundedString(input.capability, "capability", 100) } : {}),
    ...(input.profile ? { profile: boundedString(input.profile, "profile", 100) } : {}),
    ...(input.region ? { region: boundedString(input.region, "region", 20) } : {}),
    ...(contentId ? { content_id: contentId } : {}),
    ...(providerId ? { provider_id: providerId } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    ...(runId ? { run_id: runId } : {}),
    ...(input.reason ? { reason: normalizeReason(input.reason) } : {}),
    ...(input.before !== undefined ? { before: redactSensitive(input.before) } : {}),
    ...(input.after !== undefined ? { after: redactSensitive(input.after) } : {}),
    ...(input.metadata !== undefined ? { metadata: redactSensitive(input.metadata) } : {}),
    created_at: createdAt,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
}

function normalizeTakedownInput(input: TakedownInput): TakedownRecordDoc {
  const target = normalizeTakedownTarget(input.target);
  const reasonCode = boundedString(input.reasonCode, "reasonCode", 100);
  const reason = normalizeReason(input.reason);
  const effectiveAt = normalizeTimestamp(input.effectiveAt, "effectiveAt");
  const expiresAt = input.expiresAt
    ? normalizeDate(input.expiresAt, "expiresAt")
    : undefined;
  if (expiresAt && expiresAt.getTime() <= Date.parse(effectiveAt)) {
    throw new ComplianceValidationError("expiresAt 必须晚于 effectiveAt");
  }
  const idempotencyKey = input.idempotencyKey
    ? boundedString(input.idempotencyKey, "idempotencyKey", 300)
    : generatedIdempotencyKey("takedown", { target, reasonCode, reason });
  const now = new Date().toISOString();
  return {
    takedown_id: randomUUID(),
    idempotency_key: idempotencyKey,
    target,
    status: "active",
    reason_code: reasonCode,
    reason,
    ...(input.evidence !== undefined ? { evidence: redactSensitive(input.evidence) } : {}),
    requested_by: normalizeActor(input.requestedBy, "admin"),
    effective_at: effectiveAt,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    created_at: now,
    updated_at: now,
  };
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MongoComplianceStore implements ComplianceStore {
  private readonly policies: Collection<PluginPolicyDoc>;
  private readonly audits: Collection<AuditEventDoc>;
  private readonly takedowns: Collection<TakedownRecordDoc>;

  constructor(db: Db) {
    this.policies = db.collection<PluginPolicyDoc>(COLLECTIONS.PLUGIN_POLICIES);
    this.audits = db.collection<AuditEventDoc>(COLLECTIONS.AUDIT_EVENTS);
    this.takedowns = db.collection<TakedownRecordDoc>(COLLECTIONS.TAKEDOWN_RECORDS);
  }

  async getPluginPolicy(pluginId: string, pluginVersion: string): Promise<PluginPolicyDoc | null> {
    return this.policies.findOne({ plugin_id: pluginId, plugin_version: pluginVersion });
  }

  async listPluginPolicies(query: PluginPolicyQuery): Promise<PluginPolicyDoc[]> {
    const filter: Filter<PluginPolicyDoc> = {};
    if (query.pluginId) filter.plugin_id = query.pluginId;
    if (query.status) {
      filter.status = Array.isArray(query.status) ? { $in: query.status } : query.status;
    }
    if (query.enabled !== undefined) filter.enabled = query.enabled;
    return this.policies
      .find(filter)
      .sort({ updated_at: -1 })
      .limit(Math.min(Math.max(query.limit ?? 100, 1), 500))
      .toArray();
  }

  async upsertPluginPolicy(document: PluginPolicyDoc): Promise<PluginPolicyDoc> {
    const withoutId = { ...document };
    delete withoutId._id;
    const updateFields = Object.fromEntries(
      Object.entries(withoutId).filter(([key]) => key !== "created_at")
    ) as Omit<PluginPolicyDoc, "_id" | "created_at">;
    const result = await this.policies.findOneAndUpdate(
      { plugin_id: document.plugin_id, plugin_version: document.plugin_version },
      {
        $set: updateFields,
        $setOnInsert: { created_at: document.created_at },
      },
      { upsert: true, returnDocument: "after" }
    );
    if (!result) throw new Error("插件策略写入后无法读取");
    return result;
  }

  async findAuditByIdempotencyKey(key: string): Promise<AuditEventDoc | null> {
    return this.audits.findOne({ idempotency_key: key });
  }

  async insertAuditEvent(document: AuditEventDoc): Promise<AuditEventDoc> {
    try {
      await this.audits.insertOne(document as OptionalId<AuditEventDoc>);
      return document;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const existing = await this.findAuditByIdempotencyKey(document.idempotency_key);
      if (!existing) throw error;
      return existing;
    }
  }

  async listAuditEvents(query: AuditEventQuery): Promise<AuditEventDoc[]> {
    const filter: Filter<AuditEventDoc> = {};
    if (query.action) filter.action = query.action;
    if (query.pluginId) filter.plugin_id = query.pluginId;
    if (query.contentId) filter.content_id = query.contentId;
    if (query.providerId) filter.provider_id = query.providerId;
    if (query.runId) filter.run_id = query.runId;
    if (query.actorId) filter["actor.id"] = query.actorId;
    if (query.before) filter.created_at = { $lt: query.before };
    return this.audits
      .find(filter)
      .sort({ created_at: -1 })
      .limit(Math.min(Math.max(query.limit ?? 50, 1), 200))
      .toArray();
  }

  async findTakedownByIdempotencyKey(key: string): Promise<TakedownRecordDoc | null> {
    return this.takedowns.findOne({ idempotency_key: key });
  }

  async insertTakedown(document: TakedownRecordDoc): Promise<TakedownRecordDoc> {
    try {
      await this.takedowns.insertOne(document as OptionalId<TakedownRecordDoc>);
      return document;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const existing = await this.findTakedownByIdempotencyKey(document.idempotency_key);
      if (!existing) throw error;
      return existing;
    }
  }

  async updateTakedown(
    takedownId: string,
    patch: Partial<TakedownRecordDoc>
  ): Promise<TakedownRecordDoc | null> {
    const set = { ...patch };
    delete set._id;
    delete set.takedown_id;
    return this.takedowns.findOneAndUpdate(
      { takedown_id: takedownId },
      { $set: set },
      { returnDocument: "after" }
    );
  }

  async getTakedownById(takedownId: string): Promise<TakedownRecordDoc | null> {
    return this.takedowns.findOne({ takedown_id: takedownId });
  }

  async listTakedowns(query: TakedownQuery): Promise<TakedownRecordDoc[]> {
    const filter: Filter<TakedownRecordDoc> = {};
    if (query.status) {
      filter.status = Array.isArray(query.status) ? { $in: query.status } : query.status;
    }
    if (query.contentId) filter["target.content_id"] = query.contentId;
    if (query.providerId) filter["target.provider_id"] = query.providerId;
    if (query.pluginId) filter["target.plugin_id"] = query.pluginId;
    if (query.resourceId) filter["target.resource_id"] = query.resourceId;
    if (query.before) filter.created_at = { $lt: query.before };
    if (!query.includeExpired) {
      filter.$or = [
        { expires_at: { $exists: false } },
        { expires_at: { $gt: new Date() } },
      ];
    }
    return this.takedowns
      .find(filter)
      .sort({ created_at: -1 })
      .limit(Math.min(Math.max(query.limit ?? 50, 1), 200))
      .toArray();
  }

  async findActiveTakedown(target: {
    contentId?: string;
    providerId?: string;
    pluginId?: string;
    resourceId?: string;
  }): Promise<TakedownRecordDoc | null> {
    const clauses: Filter<TakedownRecordDoc>[] = [];
    if (target.contentId) clauses.push({ "target.content_id": target.contentId });
    if (target.providerId) clauses.push({ "target.provider_id": target.providerId });
    if (target.pluginId) clauses.push({ "target.plugin_id": target.pluginId });
    if (target.resourceId) clauses.push({ "target.resource_id": target.resourceId });
    if (clauses.length === 0) return null;
    const now = new Date();
    const nowIso = now.toISOString();
    return this.takedowns.findOne({
      status: "active",
      $or: clauses,
      effective_at: { $lte: nowIso },
      $and: [{ $or: [{ expires_at: { $exists: false } }, { expires_at: { $gt: now } }] }],
    } as Filter<TakedownRecordDoc>, { sort: { created_at: -1 } });
  }
}

/** Small in-memory store used by unit tests and dry-run tooling. */
export function createInMemoryComplianceStore(): ComplianceStore {
  const policies = new Map<string, PluginPolicyDoc>();
  const audits = new Map<string, AuditEventDoc>();
  const takedowns = new Map<string, TakedownRecordDoc>();
  return {
    async getPluginPolicy(pluginId, pluginVersion) {
      const value = policies.get(`${pluginId}\u0000${pluginVersion}`);
      return value ? clone(value) : null;
    },
    async listPluginPolicies(query) {
      const statuses = query.status
        ? new Set(Array.isArray(query.status) ? query.status : [query.status])
        : undefined;
      return [...policies.values()]
        .filter((item) => !query.pluginId || item.plugin_id === query.pluginId)
        .filter((item) => !statuses || statuses.has(item.status))
        .filter((item) => query.enabled === undefined || item.enabled === query.enabled)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, Math.min(Math.max(query.limit ?? 100, 1), 500))
        .map(clone);
    },
    async upsertPluginPolicy(document) {
      const key = `${document.plugin_id}\u0000${document.plugin_version}`;
      const existing = policies.get(key);
      const next = { ...(existing || {}), ...clone(document) } as PluginPolicyDoc;
      policies.set(key, next);
      return clone(next);
    },
    async findAuditByIdempotencyKey(key) {
      for (const value of audits.values()) if (value.idempotency_key === key) return clone(value);
      return null;
    },
    async insertAuditEvent(document) {
      const existing = await this.findAuditByIdempotencyKey(document.idempotency_key);
      if (existing) return existing;
      audits.set(document.event_id, clone(document));
      return clone(document);
    },
    async listAuditEvents(query) {
      const values = [...audits.values()]
        .filter((event) => !query.action || event.action === query.action)
        .filter((event) => !query.pluginId || event.plugin_id === query.pluginId)
        .filter((event) => !query.contentId || event.content_id === query.contentId)
        .filter((event) => !query.providerId || event.provider_id === query.providerId)
        .filter((event) => !query.runId || event.run_id === query.runId)
        .filter((event) => !query.actorId || event.actor.id === query.actorId)
        .filter((event) => !query.before || event.created_at < query.before)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return values.slice(0, Math.min(Math.max(query.limit ?? 50, 1), 200)).map(clone);
    },
    async findTakedownByIdempotencyKey(key) {
      for (const value of takedowns.values()) if (value.idempotency_key === key) return clone(value);
      return null;
    },
    async insertTakedown(document) {
      const existing = await this.findTakedownByIdempotencyKey(document.idempotency_key);
      if (existing) return existing;
      takedowns.set(document.takedown_id, clone(document));
      return clone(document);
    },
    async updateTakedown(takedownId, patch) {
      const existing = takedowns.get(takedownId);
      if (!existing) return null;
      const next = { ...existing, ...clone(patch), updated_at: new Date().toISOString() };
      takedowns.set(takedownId, next);
      return clone(next);
    },
    async getTakedownById(takedownId) {
      const value = takedowns.get(takedownId);
      return value ? clone(value) : null;
    },
    async listTakedowns(query) {
      const statuses = query.status
        ? new Set(Array.isArray(query.status) ? query.status : [query.status])
        : undefined;
      const now = new Date();
      return [...takedowns.values()]
        .filter((item) => !statuses || statuses.has(item.status))
        .filter((item) => !query.contentId || item.target.content_id === query.contentId)
        .filter((item) => !query.providerId || item.target.provider_id === query.providerId)
        .filter((item) => !query.pluginId || item.target.plugin_id === query.pluginId)
        .filter((item) => !query.resourceId || item.target.resource_id === query.resourceId)
        .filter((item) => !query.before || item.created_at < query.before)
        .filter(
          (item) =>
            query.includeExpired ||
            !item.expires_at ||
            item.expires_at.getTime() > now.getTime()
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, Math.min(Math.max(query.limit ?? 50, 1), 200))
        .map(clone);
    },
    async findActiveTakedown(target) {
      const now = new Date();
      const values = [...takedowns.values()]
        .filter((item) => item.status === "active")
        .filter(
          (item) =>
            !item.effective_at || Date.parse(item.effective_at) <= now.getTime()
        )
        .filter(
          (item) =>
            !item.expires_at || item.expires_at.getTime() > now.getTime()
        )
        .filter((item) =>
          Boolean(
            (target.contentId && item.target.content_id === target.contentId) ||
              (target.providerId && item.target.provider_id === target.providerId) ||
              (target.pluginId && item.target.plugin_id === target.pluginId) ||
              (target.resourceId && item.target.resource_id === target.resourceId)
          )
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return values[0] ? clone(values[0]) : null;
    },
  };
}

class DefaultComplianceRepository implements ComplianceRepository {
  constructor(private readonly store: ComplianceStore) {}

  async getPluginPolicy(lookup: PluginPolicyLookup): Promise<PluginPolicyDoc | null> {
    const pluginId = assertPluginId(lookup.pluginId);
    const pluginVersion = normalizeVersion(lookup.pluginVersion);
    const exact = await this.store.getPluginPolicy(pluginId, pluginVersion);
    if (exact || pluginVersion === DEFAULT_PLUGIN_VERSION) return exact;
    return this.store.getPluginPolicy(pluginId, DEFAULT_PLUGIN_VERSION);
  }

  async listPluginPolicies(query: PluginPolicyQuery = {}): Promise<PluginPolicyDoc[]> {
    const normalized: PluginPolicyQuery = {
      ...(query.pluginId ? { pluginId: assertPluginId(query.pluginId) } : {}),
      ...(query.status ? { status: normalizePolicyStatusQuery(query.status) } : {}),
      ...(query.enabled !== undefined ? { enabled: Boolean(query.enabled) } : {}),
      limit: Math.min(Math.max(query.limit ?? 100, 1), 500),
    };
    return this.store.listPluginPolicies(normalized);
  }

  async upsertPluginPolicy(input: PluginPolicyInput): Promise<PluginPolicyDoc> {
    const pluginId = assertPluginId(input.pluginId);
    const pluginVersion = normalizeVersion(input.pluginVersion);
    const existing = await this.store.getPluginPolicy(pluginId, pluginVersion);
    const document = policyDocFromInput(
      { ...input, pluginId, pluginVersion },
      existing || undefined
    );
    return this.store.upsertPluginPolicy(document);
  }

  async ensurePluginAllowed(options: EnsurePluginAllowedOptions): Promise<PluginPolicyDecision> {
    const pluginId = assertPluginId(options.pluginId);
    const registeredPlugin = pluginRegistry.get(pluginId);
    const registered = options.registered ?? Boolean(registeredPlugin);
    const pluginVersion = normalizeVersion(
      options.pluginVersion ?? registeredPlugin?.manifest.version
    );
    const environmentMode = process.env.KERKERKER_COMPLIANCE_MODE;
    const configuredMode = options.mode ?? (
      environmentMode === "audit" || environmentMode === "enforce"
        ? environmentMode
        : complianceModeFromEnvironment()
    );

    // Registry membership is a trust boundary, not a rollout mode. Audit mode
    // must never make a database-supplied, unregistered plugin executable.
    if (!registered) {
      return {
        allowed: false,
        wouldDeny: true,
        mode: normalizeComplianceMode(configuredMode),
        reason: "plugin-not-registered",
        pluginId,
        pluginVersion,
      };
    }

    const policy = await this.getPluginPolicy({ pluginId, pluginVersion });
    const mode = normalizeComplianceMode(
      options.mode ??
        (environmentMode === "audit" || environmentMode === "enforce"
          ? environmentMode
          : policy?.enforcement_mode) ??
        configuredMode,
      "audit"
    );
    const contentId = optionalContentId(options.contentId);
    const takedown = await this.store.findActiveTakedown({
      ...(contentId ? { contentId } : {}),
      pluginId,
      providerId: pluginId,
    });
    if (takedown) {
      return policyDecision({
        mode,
        reason: "takedown-active",
        pluginId,
        pluginVersion,
        policy: policy || undefined,
        takedown,
      });
    }

    if (!policy) {
      return policyDecision({
        mode,
        reason: mode === "audit" ? "registered-legacy" : "missing-policy",
        pluginId,
        pluginVersion,
      });
    }
    if (!policy.enabled) {
      return policyDecision({
        mode,
        reason: "policy-disabled",
        pluginId,
        pluginVersion,
        policy,
      });
    }
    if (policy.status !== "approved") {
      return policyDecision({
        mode,
        reason: "policy-status",
        pluginId,
        pluginVersion,
        policy,
      });
    }
    if (pluginPolicyApprovalIssues(policy).length > 0) {
      return policyDecision({
        mode,
        reason: "policy-incomplete",
        pluginId,
        pluginVersion,
        policy,
      });
    }
    if (
      options.region &&
      !policy.regions.includes("GLOBAL") &&
      !policy.regions.includes(options.region.toUpperCase())
    ) {
      return policyDecision({
        mode,
        reason: "region-not-allowed",
        pluginId,
        pluginVersion,
        policy,
      });
    }
    return {
      allowed: true,
      wouldDeny: false,
      mode,
      reason: "approved",
      pluginId,
      pluginVersion,
      policy,
    };
  }

  async recordAudit(input: AuditEventInput): Promise<AuditEventDoc> {
    const document = normalizeAuditInput(input);
    const existing = await this.store.findAuditByIdempotencyKey(document.idempotency_key);
    if (existing) {
      assertSameAuditIdentity(existing, document);
      return existing;
    }
    const inserted = await this.store.insertAuditEvent(document);
    assertSameAuditIdentity(inserted, document);
    return inserted;
  }

  async listAuditEvents(query: AuditEventQuery = {}): Promise<AuditEventDoc[]> {
    const normalized: AuditEventQuery = {
      ...(query.action ? { action: boundedString(query.action, "action", 128) } : {}),
      ...(query.pluginId ? { pluginId: assertPluginId(query.pluginId) } : {}),
      ...(query.contentId ? { contentId: optionalContentId(query.contentId) } : {}),
      ...(query.providerId ? { providerId: assertProviderId(query.providerId) } : {}),
      ...(query.runId ? { runId: boundedString(query.runId, "runId") } : {}),
      ...(query.actorId ? { actorId: boundedString(query.actorId, "actorId") } : {}),
      ...(query.before ? { before: normalizeTimestamp(query.before, "before") } : {}),
      limit: Math.min(Math.max(query.limit ?? 50, 1), 200),
    };
    return this.store.listAuditEvents(normalized);
  }

  async createTakedown(input: TakedownInput): Promise<TakedownRecordDoc> {
    const document = normalizeTakedownInput(input);
    const existing = await this.store.findTakedownByIdempotencyKey(document.idempotency_key);
    if (existing) {
      assertSameTakedownIdentity(existing, document);
      return existing;
    }
    const inserted = await this.store.insertTakedown(document);
    assertSameTakedownIdentity(inserted, document);
    return inserted;
  }

  async resolveTakedown(
    takedownId: string,
    input: TakedownResolutionInput
  ): Promise<TakedownRecordDoc | null> {
    const normalizedId = boundedString(takedownId, "takedownId", 100);
    const resolutionStatus = String((input as { status?: unknown }).status || "");
    if (!(["resolved", "rejected", "expired"] as const).includes(
      resolutionStatus as "resolved" | "rejected" | "expired"
    )) {
      throw new ComplianceValidationError("status 必须是 resolved、rejected 或 expired");
    }
    const existing = await this.store.getTakedownById(normalizedId);
    if (!existing) return null;
    if (existing.status !== "active") {
      if (existing.status === input.status) return existing;
      throw new ComplianceIdempotencyConflictError("下架记录已经以其他状态关闭");
    }
    const now = new Date().toISOString();
    return this.store.updateTakedown(normalizedId, {
      status: resolutionStatus as Extract<TakedownStatus, "resolved" | "rejected" | "expired">,
      resolved_by: normalizeActor(input.resolvedBy, "admin"),
      ...(input.resolutionReason
        ? { resolution_reason: normalizeReason(input.resolutionReason, "resolutionReason") }
        : {}),
      resolved_at: now,
      updated_at: now,
    });
  }

  async listTakedowns(query: TakedownQuery = {}): Promise<TakedownRecordDoc[]> {
    const normalized: TakedownQuery = {
      ...(query.status ? { status: normalizeTakedownStatusQuery(query.status) } : {}),
      ...(query.contentId ? { contentId: optionalContentId(query.contentId) } : {}),
      ...(query.providerId ? { providerId: assertProviderId(query.providerId) } : {}),
      ...(query.pluginId ? { pluginId: assertPluginId(query.pluginId) } : {}),
      ...(query.resourceId ? { resourceId: boundedString(query.resourceId, "resourceId") } : {}),
      ...(query.before ? { before: normalizeTimestamp(query.before, "before") } : {}),
      ...(query.includeExpired !== undefined ? { includeExpired: Boolean(query.includeExpired) } : {}),
      limit: Math.min(Math.max(query.limit ?? 50, 1), 200),
    };
    return this.store.listTakedowns(normalized);
  }

  async getActiveTakedown(target: {
    contentId?: string;
    providerId?: string;
    pluginId?: string;
    resourceId?: string;
  }): Promise<TakedownRecordDoc | null> {
    const normalized = {
      ...(target.contentId ? { contentId: optionalContentId(target.contentId) } : {}),
      ...(target.providerId ? { providerId: assertProviderId(target.providerId) } : {}),
      ...(target.pluginId ? { pluginId: assertPluginId(target.pluginId) } : {}),
      ...(target.resourceId ? { resourceId: boundedString(target.resourceId, "resourceId") } : {}),
    };
    return this.store.findActiveTakedown(normalized);
  }
}

function normalizePolicyStatusQuery(
  value: PluginPolicyStatus | readonly PluginPolicyStatus[]
): PluginPolicyStatus | readonly PluginPolicyStatus[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((status) => !PLUGIN_POLICY_STATUSES.includes(status))) {
    throw new ComplianceValidationError("status 格式无效");
  }
  return Array.isArray(value) ? [...values] : values[0];
}

function normalizeTakedownStatusQuery(
  value: TakedownStatus | readonly TakedownStatus[]
): TakedownStatus | readonly TakedownStatus[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((status) => !TAKEDOWN_STATUSES.includes(status))) {
    throw new ComplianceValidationError("status 格式无效");
  }
  return Array.isArray(value) ? [...values] : values[0];
}

/** Fields required before an approved policy can authorize plugin execution. */
export function pluginPolicyApprovalIssues(policy: PluginPolicyDoc): string[] {
  const issues: string[] = [];
  if (!policy.owner) issues.push("owner");
  if (!policy.authorization_ref && !policy.license) issues.push("authorization_ref_or_license");
  if (!policy.terms_url) issues.push("terms_url");
  if (!policy.data_purpose) issues.push("data_purpose");
  if (!policy.retention_days) issues.push("retention_days");
  if (!policy.correction_contact) issues.push("correction_contact");
  if (!policy.takedown_contact) issues.push("takedown_contact");
  if (!policy.approved_by) issues.push("approved_by");
  if (!policy.approved_at) issues.push("approved_at");
  if (policy.legal_basis === "operator-review-required") issues.push("legal_basis");
  if (
    policy.content_scope === "operator-review-required" ||
    (Array.isArray(policy.content_scope) && policy.content_scope.includes("operator-review-required"))
  ) {
    issues.push("content_scope");
  }
  return issues;
}

function policyDecision(input: {
  mode: ComplianceEnforcementMode;
  reason: Exclude<PluginPolicyDecision["reason"], "approved">;
  pluginId: string;
  pluginVersion: string;
  policy?: PluginPolicyDoc;
  takedown?: TakedownRecordDoc;
}): PluginPolicyDecision {
  return {
    // A verified takedown is an immediate safety control, not a rollout
    // warning. It must block even while ordinary policy gaps remain in audit
    // mode; otherwise a rights request could be ignored until enforcement is
    // enabled globally.
    allowed: input.reason === "takedown-active" ? false : input.mode === "audit",
    wouldDeny: true,
    mode: input.mode,
    reason: input.reason,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.takedown ? { takedown: input.takedown } : {}),
  };
}

function auditIdentity(event: AuditEventDoc): unknown {
  return {
    idempotency_key: event.idempotency_key,
    actor: event.actor,
    action: event.action,
    target: event.target,
    plugin_id: event.plugin_id,
    plugin_version: event.plugin_version,
    capability: event.capability,
    profile: event.profile,
    region: event.region,
    content_id: event.content_id,
    provider_id: event.provider_id,
    request_id: event.request_id,
    run_id: event.run_id,
    reason: event.reason,
    before: event.before,
    after: event.after,
    metadata: event.metadata,
  };
}

function assertSameAuditIdentity(existing: AuditEventDoc, requested: AuditEventDoc): void {
  if (fingerprint(auditIdentity(existing)) !== fingerprint(auditIdentity(requested))) {
    throw new ComplianceIdempotencyConflictError();
  }
}

function takedownIdentity(record: TakedownRecordDoc): unknown {
  return {
    idempotency_key: record.idempotency_key,
    target: record.target,
    reason_code: record.reason_code,
    reason: record.reason,
    evidence: record.evidence,
    requested_by: record.requested_by,
    effective_at: record.effective_at,
    expires_at: record.expires_at,
  };
}

function assertSameTakedownIdentity(
  existing: TakedownRecordDoc,
  requested: TakedownRecordDoc
): void {
  if (fingerprint(takedownIdentity(existing)) !== fingerprint(takedownIdentity(requested))) {
    throw new ComplianceIdempotencyConflictError();
  }
}

export function createComplianceRepository(store: ComplianceStore): ComplianceRepository {
  return new DefaultComplianceRepository(store);
}

export async function getComplianceRepository(): Promise<ComplianceRepository> {
  return createComplianceRepository(new MongoComplianceStore(await getDatabase()));
}

export async function getPluginPolicy(
  pluginId: string,
  pluginVersion?: string
): Promise<PluginPolicyDoc | null> {
  return (await getComplianceRepository()).getPluginPolicy({ pluginId, pluginVersion });
}

export async function listPluginPolicies(
  query: PluginPolicyQuery = {}
): Promise<PluginPolicyDoc[]> {
  return (await getComplianceRepository()).listPluginPolicies(query);
}

export async function upsertPluginPolicy(input: PluginPolicyInput): Promise<PluginPolicyDoc> {
  return (await getComplianceRepository()).upsertPluginPolicy(input);
}

export async function ensurePluginAllowed(
  options: EnsurePluginAllowedOptions
): Promise<PluginPolicyDecision> {
  return (await getComplianceRepository()).ensurePluginAllowed(options);
}

export async function recordAudit(input: AuditEventInput): Promise<AuditEventDoc> {
  return (await getComplianceRepository()).recordAudit(input);
}

export async function listAuditEvents(query: AuditEventQuery = {}): Promise<AuditEventDoc[]> {
  return (await getComplianceRepository()).listAuditEvents(query);
}

export async function createTakedown(input: TakedownInput): Promise<TakedownRecordDoc> {
  return (await getComplianceRepository()).createTakedown(input);
}

export async function resolveTakedown(
  takedownId: string,
  input: TakedownResolutionInput
): Promise<TakedownRecordDoc | null> {
  return (await getComplianceRepository()).resolveTakedown(takedownId, input);
}

export async function listTakedowns(query: TakedownQuery = {}): Promise<TakedownRecordDoc[]> {
  return (await getComplianceRepository()).listTakedowns(query);
}

export async function getActiveTakedown(target: {
  contentId?: string;
  providerId?: string;
  pluginId?: string;
  resourceId?: string;
}): Promise<TakedownRecordDoc | null> {
  return (await getComplianceRepository()).getActiveTakedown(target);
}
