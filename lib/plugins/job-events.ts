import type {
  PluginJobEvent,
  PluginJobEventKind,
  PluginJobEventMetadata,
  PluginJobEventProgress,
  PluginJobEventStatus,
} from "@/packages/kerkerker-plugin-contract/src/index";
import { redactSensitive } from "@/lib/compliance-types";

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
  append(input: PluginJobEventAppendInput): Promise<PluginJobEventRecord>;
  list(options: PluginJobEventListOptions): Promise<PluginJobEventRecord[]>;
}

export function redactPluginJobEventError(
  error: PluginJobEvent["error"]
): PluginJobEventRecord["error"] {
  if (!error) return undefined;
  return {
    ...(error.code
      ? { code: String(redactSensitive(error.code, 0, "error_code")) }
      : {}),
    message: String(redactSensitive(error.message, 0, "error_message")),
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
