import type {
  PluginJobEvent,
  PluginJobEventKind,
  PluginJobEventMetadata,
  PluginJobEventProgress,
  PluginJobEventStatus,
} from "@/packages/kerkerker-plugin-contract/src/index";
import {
  REDACTED_VALUE,
  redactSensitive,
} from "@/lib/compliance-types";

export interface PluginJobEventRecord {
  readonly schema: PluginJobEvent["schema"];
  readonly event_id: string;
  readonly event_hash: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly kind: PluginJobEventKind;
  readonly occurred_at: string;
  readonly received_at: string;
  readonly metadata: PluginJobEventMetadata;
  readonly status: PluginJobEventStatus;
  readonly progress: PluginJobEventProgress;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly expires_at: Date;
}

export interface PluginJobEventAppendInput {
  readonly event: PluginJobEvent;
  readonly eventHash: string;
  readonly receivedAt: string;
  readonly expiresAt: Date;
}

export interface PluginJobEventListOptions {
  readonly runId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface PluginJobEventStore {
  append(record: PluginJobEventRecord): Promise<PluginJobEventRecord>;
  list(options: PluginJobEventListOptions): Promise<PluginJobEventRecord[]>;
}

const EMBEDDED_URL_PATTERN =
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/gu;
const SENSITIVE_URL_PARAMETER_PATTERN =
  /(?:token|key|secret|pass(?:word|wd)?|pwd|auth|code|signature|sig|credential|session|cookie)/i;
const AUTHORIZATION_HEADER_PATTERN =
  /\b((?:proxy[-_ ]?)?authorization)\s*([=:])\s*[^\r\n]*/giu;
const AUTH_VALUE_PATTERN =
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/giu;
const JWT_PATTERN =
  /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/gu;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(?:\\?["'])?(\b[A-Za-z0-9_.-]*(?:pass(?:word|wd)?|pwd|token|secret|api[-_]?key|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|aws[-_]?secret[-_]?access[-_]?key|private[-_]?key|authorization|credential|cookie|session|signature|access[-_]?code|share[-_]?code|extract[-_]?code)[A-Za-z0-9_.-]*\b)(?:\\?["'])?\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;&#}\]]+)/giu;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/;

function redactEmbeddedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = REDACTED_VALUE;
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMETER_PATTERN.test(key)) {
        url.searchParams.set(key, REDACTED_VALUE);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

/** Redact credentials from unstructured worker error text before persistence. */
export function redactPluginJobEventText(value: string): string {
  const sanitized = value
    .replace(EMBEDDED_URL_PATTERN, redactEmbeddedUrl)
    .replace(
      AUTHORIZATION_HEADER_PATTERN,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED_VALUE}`
    )
    .replace(AUTH_VALUE_PATTERN, (_match, scheme: string) =>
      `${scheme} ${REDACTED_VALUE}`
    )
    .replace(JWT_PATTERN, REDACTED_VALUE)
    .replace(
      SENSITIVE_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED_VALUE}`
    );
  return String(redactSensitive(sanitized));
}

export function redactPluginJobEventError(
  error: PluginJobEvent["error"]
): PluginJobEventRecord["error"] {
  if (!error) return undefined;
  return {
    ...(error.code
      ? {
          code: ERROR_CODE_PATTERN.test(error.code)
            ? error.code
            : "UNCLASSIFIED_ERROR",
        }
      : {}),
    message: redactPluginJobEventText(error.message),
  };
}

export function createPluginJobEventRecord(
  input: PluginJobEventAppendInput
): PluginJobEventRecord {
  const { event } = input;
  const error = redactPluginJobEventError(event.error);
  return {
    schema: event.schema,
    event_id: event.event_id,
    event_hash: input.eventHash,
    run_id: event.metadata.run_id,
    sequence: event.sequence,
    kind: event.kind,
    occurred_at: event.occurred_at,
    received_at: input.receivedAt,
    metadata: { ...event.metadata },
    status: event.status,
    progress: { ...event.progress },
    ...(error ? { error } : {}),
    expires_at: new Date(input.expiresAt),
  };
}

export function clonePluginJobEventRecord(
  record: PluginJobEventRecord
): PluginJobEventRecord {
  return {
    ...record,
    metadata: { ...record.metadata },
    progress: { ...record.progress },
    ...(record.error ? { error: { ...record.error } } : {}),
    expires_at: new Date(record.expires_at),
  };
}
