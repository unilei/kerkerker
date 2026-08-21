import type { Collection, Db, Document, ObjectId } from "mongodb";
import { getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import {
  PluginJobError,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobRun,
  type PluginJobStatus,
  type PluginJobStore,
} from "@/lib/plugins/job-runner";

interface PluginJobDocument extends PluginJobRun, Document {
  _id?: ObjectId;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
  ) as T;
}

function toRun(document: PluginJobDocument): PluginJobRun {
  const { _id: _ignored, ...run } = document;
  return {
    ...run,
    actor: { ...run.actor },
    retry_policy: { ...run.retry_policy },
    ...(run.lease ? { lease: { ...run.lease } } : {}),
    progress: { ...run.progress },
    ...(run.error ? { error: { ...run.error } } : {}),
    metadata: { ...run.metadata },
    ...(run.expires_at ? { expires_at: new Date(run.expires_at) } : {}),
  };
}

function duplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === 11000);
}

function sameImmutableFields(left: PluginJobRun, right: PluginJobRun): boolean {
  return left.plugin_id === right.plugin_id &&
    left.plugin_version === right.plugin_version &&
    left.profile_id === right.profile_id &&
    left.config_version === right.config_version;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new RangeError("任务查询 limit 必须是 1 到 500 的整数");
  }
  return value;
}

/** Mongo-backed implementation of the provider-neutral PluginJobStore port. */
export class MongoPluginJobStore implements PluginJobStore {
  constructor(private readonly collection: Collection<PluginJobDocument>) {}

  async create(run: PluginJobRun): Promise<PluginJobRun> {
    const existing = await this.findByIdempotencyKey(run.idempotency_key);
    if (existing) {
      if (!sameImmutableFields(existing, run)) {
        throw new PluginJobError(
          PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "幂等键已经绑定到其他插件或配置"
        );
      }
      return existing;
    }

    try {
      await this.collection.insertOne(withoutUndefined({ ...run }));
      return { ...run };
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      const winner = await this.findByIdempotencyKey(run.idempotency_key);
      if (winner) {
        if (!sameImmutableFields(winner, run)) {
          throw new PluginJobError(
            PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "幂等键已经绑定到其他插件或配置"
          );
        }
        return winner;
      }
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "任务幂等键或 run_id 已被其他任务占用"
      );
    }
  }

  async get(runId: string): Promise<PluginJobRun | null> {
    const document = await this.collection.findOne({ run_id: runId });
    return document ? toRun(document) : null;
  }

  async findByIdempotencyKey(key: string): Promise<PluginJobRun | null> {
    const document = await this.collection.findOne({ idempotency_key: key });
    return document ? toRun(document) : null;
  }

  async update(
    runId: string,
    expectedRevision: number,
    mutate: (current: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun | null> {
    const currentDocument = await this.collection.findOne({ run_id: runId });
    if (!currentDocument || currentDocument.revision !== expectedRevision) return null;
    const current = toRun(currentDocument);
    const next = mutate(current);
    const replacement = withoutUndefined({ ...next });
    const currentKeys = new Set(Object.keys(current));
    const nextKeys = new Set(Object.keys(replacement));
    const unset = [...currentKeys]
      .filter((key) => !nextKeys.has(key))
      .reduce<Record<string, "">>((result, key) => {
        result[key] = "";
        return result;
      }, {});

    const update: { $set: PluginJobDocument; $unset?: Record<string, ""> } = {
      $set: replacement as PluginJobDocument,
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    };
    const updated = await this.collection.findOneAndUpdate(
      { run_id: runId, revision: expectedRevision },
      update,
      { returnDocument: "after" }
    );
    return updated ? toRun(updated) : null;
  }

  async list(options: { status?: PluginJobStatus; limit?: number } = {}): Promise<PluginJobRun[]> {
    const limit = normalizeLimit(options.limit);
    const filter = options.status ? { status: options.status } : {};
    const documents = await this.collection
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
    return documents.map(toRun);
  }
}

export function createMongoPluginJobStore(db: Db): MongoPluginJobStore {
  return new MongoPluginJobStore(
    db.collection<PluginJobDocument>(COLLECTIONS.PLUGIN_JOBS)
  );
}

export async function getMongoPluginJobStore(): Promise<MongoPluginJobStore> {
  return createMongoPluginJobStore(await getDatabase());
}
