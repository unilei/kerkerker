import type { Collection, Db, Document, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/lib/constants/db";
import { getDatabase } from "@/lib/db";
import {
  clonePluginJobEventRecord,
  createPluginJobEventRecord,
  type PluginJobEventAppendInput,
  type PluginJobEventListOptions,
  type PluginJobEventRecord,
  type PluginJobEventStore,
} from "@/lib/plugins/job-events";
import {
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
} from "@/lib/plugins/job-runner";

interface PluginJobEventDocument extends PluginJobEventRecord, Document {
  _id?: ObjectId;
}

function duplicateKey(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === 11000
  );
}

function toRecord(document: PluginJobEventDocument): PluginJobEventRecord {
  const record = { ...document } as PluginJobEventDocument;
  delete record._id;
  return clonePluginJobEventRecord({
    ...record,
    expires_at: new Date(record.expires_at),
  });
}

function assertSameEvent(
  existing: PluginJobEventRecord,
  expected: PluginJobEventRecord
): void {
  if (
    existing.event_id !== expected.event_id ||
    existing.event_hash !== expected.event_hash ||
    existing.run_id !== expected.run_id ||
    existing.sequence !== expected.sequence
  ) {
    throw new PluginJobError(
      PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      "任务事件序号已经绑定到其他内容"
    );
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new RangeError("任务事件查询 limit 必须是 1 到 500 的整数");
  }
  return value;
}

function normalizeAfterSequence(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("afterSequence 必须是非负整数");
  }
  return value;
}

/** Mongo-backed append-only receipt store for accepted worker events. */
export class MongoPluginJobEventStore implements PluginJobEventStore {
  constructor(private readonly collection: Collection<PluginJobEventDocument>) {}

  async append(input: PluginJobEventAppendInput): Promise<PluginJobEventRecord> {
    const expected = createPluginJobEventRecord(input);
    const existing = await this.collection.findOne({ event_id: expected.event_id });
    if (existing) {
      const record = toRecord(existing);
      assertSameEvent(record, expected);
      return record;
    }

    try {
      await this.collection.insertOne({ ...expected });
      return clonePluginJobEventRecord(expected);
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const winner =
        (await this.collection.findOne({ event_id: expected.event_id })) ||
        (await this.collection.findOne({
          run_id: expected.run_id,
          sequence: expected.sequence,
        }));
      if (!winner) {
        throw new PluginJobError(
          PLUGIN_JOB_ERROR_CODES.CONFLICT,
          "任务事件写入发生冲突"
        );
      }
      const record = toRecord(winner);
      assertSameEvent(record, expected);
      return record;
    }
  }

  async list(options: PluginJobEventListOptions): Promise<PluginJobEventRecord[]> {
    const limit = normalizeLimit(options.limit);
    const afterSequence = normalizeAfterSequence(options.afterSequence);
    const filter = {
      run_id: options.runId,
      ...(afterSequence !== undefined
        ? { sequence: { $gt: afterSequence } }
        : {}),
    };
    const documents = await this.collection
      .find(filter)
      .sort({ sequence: 1 })
      .limit(limit)
      .toArray();
    return documents.map(toRecord);
  }
}

export function createMongoPluginJobEventStore(db: Db): MongoPluginJobEventStore {
  return new MongoPluginJobEventStore(
    db.collection<PluginJobEventDocument>(COLLECTIONS.PLUGIN_JOB_EVENTS)
  );
}

export async function getMongoPluginJobEventStore(): Promise<MongoPluginJobEventStore> {
  return createMongoPluginJobEventStore(await getDatabase());
}
