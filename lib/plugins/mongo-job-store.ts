import type { Collection, Db, Document, ObjectId } from "mongodb";
import { getDatabase } from "@/lib/db";
import { COLLECTIONS } from "@/lib/constants/db";
import {
  PluginJobError,
  LEGACY_EXTERNAL_REPORT_JOB_ID,
  PLUGIN_JOB_ERROR_CODES,
  type PluginJobLeaseCredential,
  type PluginJobRun,
  type PluginJobStatus,
  type PluginJobStoreClaimInput,
  type PluginJobStore,
} from "@/lib/plugins/job-runner";
import { clonePluginJobEventRecord } from "@/lib/plugins/job-events";

interface PluginJobDocument extends PluginJobRun, Document {
  _id?: ObjectId;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
  ) as T;
}

function toRun(document: PluginJobDocument): PluginJobRun {
  const run = { ...document } as PluginJobDocument;
  delete run._id;
  const hasHostClaimable = Object.prototype.hasOwnProperty.call(
    run,
    "host_claimable"
  );
  const normalizedHostClaimable = !hasHostClaimable
    ? undefined
    : run.host_claimable === true;
  const runWithoutHostClaimable = { ...run };
  delete runWithoutHostClaimable.host_claimable;
  const reportRun = run.metadata?.source === "job-report";
  const leaseFence = Number.isSafeInteger(run.lease_fence) && run.lease_fence >= 0
    ? run.lease_fence
    : 0;
  const lease = run.lease
    ? {
        ...run.lease,
        token: typeof run.lease.token === "string" ? run.lease.token : "",
        fence: Number.isSafeInteger(run.lease.fence) && run.lease.fence >= 0
          ? run.lease.fence
          : leaseFence,
      }
    : undefined;
  return {
    ...runWithoutHostClaimable,
    job_id: typeof run.job_id === "string"
      ? run.job_id
      : reportRun
        ? LEGACY_EXTERNAL_REPORT_JOB_ID
        : "legacy.unspecified",
    control_mode: run.control_mode ?? (reportRun ? "external-report" : "host"),
    ...(hasHostClaimable
      ? { host_claimable: normalizedHostClaimable }
      : {}),
    lease_fence: leaseFence,
    actor: { ...run.actor },
    retry_policy: { ...run.retry_policy },
    ...(lease ? { lease } : {}),
    progress: { ...run.progress },
    ...(run.error ? { error: { ...run.error } } : {}),
    metadata: { ...run.metadata },
    ...(run.pending_event_receipt
      ? {
          pending_event_receipt: clonePluginJobEventRecord(
            run.pending_event_receipt
          ),
        }
      : {}),
    ...(run.expires_at ? { expires_at: new Date(run.expires_at) } : {}),
  };
}

function duplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === 11000);
}

function sameIdempotencyIdentity(left: PluginJobRun, right: PluginJobRun): boolean {
  return left.job_id === right.job_id &&
    left.control_mode === right.control_mode &&
    left.plugin_id === right.plugin_id &&
    left.plugin_version === right.plugin_version &&
    left.profile_id === right.profile_id &&
    left.config_version === right.config_version;
}

function sameImmutableFields(left: PluginJobRun, right: PluginJobRun): boolean {
  return left.run_id === right.run_id &&
    left.idempotency_key === right.idempotency_key &&
    sameIdempotencyIdentity(left, right);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new RangeError("任务查询 limit 必须是 1 到 500 的整数");
  }
  return value;
}

const MONGO_ISO_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S.%LZ";

function mongoNowIso(): Document {
  return {
    $dateToString: {
      date: "$$NOW",
      format: MONGO_ISO_DATE_FORMAT,
      timezone: "UTC",
    },
  };
}

function mongoLeaseExpiryIso(leaseTtlMs: number): Document {
  return {
    $dateToString: {
      date: {
        $dateAdd: {
          startDate: "$$NOW",
          unit: "millisecond",
          amount: leaseTtlMs,
        },
      },
      format: MONGO_ISO_DATE_FORMAT,
      timezone: "UTC",
    },
  };
}

function mongoTimestampComparison(
  field: string,
  operator: "$lte" | "$gt"
): Document {
  const parsedDate = () => ({
    $convert: {
      input: field,
      to: "date",
      onError: null,
      onNull: null,
    },
  });
  return {
    $and: [
      { $in: [{ $type: field }, ["string", "date"]] },
      { $ne: [parsedDate(), null] },
      { [operator]: [parsedDate(), "$$NOW"] },
    ],
  };
}

/** Mongo-backed implementation of the provider-neutral PluginJobStore port. */
export class MongoPluginJobStore implements PluginJobStore {
  constructor(private readonly collection: Collection<PluginJobDocument>) {}

  async create(run: PluginJobRun): Promise<PluginJobRun> {
    const existing = await this.findByIdempotencyKey(run.idempotency_key);
    if (existing) {
      if (!sameIdempotencyIdentity(existing, run)) {
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
        if (!sameIdempotencyIdentity(winner, run)) {
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

  async claimNext(input: PluginJobStoreClaimInput): Promise<PluginJobRun | null> {
    const nextFence = { $add: [{ $ifNull: ["$lease_fence", 0] }, 1] };
    const filter: Document = {
      ...(input.runId ? { run_id: input.runId } : {}),
      ...(input.jobIds ? { job_id: { $in: [...input.jobIds] } } : {}),
      control_mode: "host",
      $and: [
        {
          $or: [
            { host_claimable: { $exists: false } },
            { host_claimable: true },
          ],
        },
        {
          $or: [
            { status: "queued" },
            {
              status: "retry_waiting",
              $expr: mongoTimestampComparison("$next_retry_at", "$lte"),
            },
            {
              status: "running",
              $expr: mongoTimestampComparison("$lease.expires_at", "$lte"),
            },
          ],
        },
      ],
      cancel_requested: false,
      $expr: {
        $lt: [
          { $ifNull: ["$attempt", 0] },
          "$retry_policy.maxAttempts",
        ],
      },
    };
    const update: Document[] = [
      {
        $set: {
          status: "running",
          attempt: { $add: [{ $ifNull: ["$attempt", 0] }, 1] },
          lease_fence: nextFence,
          lease: {
            owner: { $literal: input.owner },
            token: { $literal: input.token },
            fence: nextFence,
            acquired_at: mongoNowIso(),
            heartbeat_at: mongoNowIso(),
            expires_at: mongoLeaseExpiryIso(input.leaseTtlMs),
          },
          heartbeat_at: mongoNowIso(),
          next_retry_at: "$$REMOVE",
          revision: { $add: [{ $ifNull: ["$revision", 0] }, 1] },
          updated_at: mongoNowIso(),
          started_at: {
            $ifNull: ["$started_at", mongoNowIso()],
          },
        },
      },
    ];
    const claimed = await this.collection.findOneAndUpdate(filter, update, {
      sort: { created_at: 1, run_id: 1 },
      returnDocument: "after",
    });
    return claimed ? toRun(claimed) : null;
  }

  async recoverExpiredLeases(_now: string): Promise<number> {
    void _now;
    const result = await this.collection.updateMany(
      {
        control_mode: "host",
        status: "running",
        $and: [
          {
            $or: [
              { host_claimable: { $exists: false } },
              { host_claimable: true },
            ],
          },
          {
            $expr: mongoTimestampComparison("$lease.expires_at", "$lte"),
          },
          {
            $or: [
              { cancel_requested: true },
              {
                $expr: {
                  $gte: ["$attempt", "$retry_policy.maxAttempts"],
                },
              },
            ],
          },
        ],
      },
      [
        {
          $set: {
            status: {
              $cond: [
                { $eq: ["$cancel_requested", true] },
                "cancelled",
                "failed",
              ],
            },
            lease: "$$REMOVE",
            error: {
              $cond: [
                { $eq: ["$cancel_requested", true] },
                "$$REMOVE",
                {
                  $literal: {
                    code: PLUGIN_JOB_ERROR_CODES.RETRY_EXHAUSTED,
                    message: "任务租约已过期且执行次数已耗尽",
                    retryable: false,
                  },
                },
              ],
            },
            finished_at: mongoNowIso(),
            updated_at: mongoNowIso(),
            revision: { $add: [{ $ifNull: ["$revision", 0] }, 1] },
          },
        },
      ]
    );
    return result.modifiedCount;
  }

  async renewLease(
    runId: string,
    expectedRevision: number,
    credential: PluginJobLeaseCredential,
    leaseTtlMs: number,
    _now: string
  ): Promise<PluginJobRun | null> {
    void _now;
    const filter: Document = {
      run_id: runId,
      revision: expectedRevision,
      status: "running",
      lease_fence: credential.fence,
      "lease.owner": credential.owner,
      "lease.token": credential.token,
      "lease.fence": credential.fence,
      $expr: mongoTimestampComparison("$lease.expires_at", "$gt"),
    };
    const updated = await this.collection.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            heartbeat_at: mongoNowIso(),
            "lease.heartbeat_at": mongoNowIso(),
            "lease.expires_at": mongoLeaseExpiryIso(leaseTtlMs),
            revision: { $add: [{ $ifNull: ["$revision", 0] }, 1] },
            updated_at: mongoNowIso(),
          },
        },
      ],
      { returnDocument: "after" }
    );
    return updated ? toRun(updated) : null;
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
    if (!sameImmutableFields(current, next)) {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "任务更新不能改变不可变身份"
      );
    }
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

  async updateWithLease(
    runId: string,
    expectedRevision: number,
    credential: PluginJobLeaseCredential,
    _now: string,
    mutate: (current: PluginJobRun) => PluginJobRun
  ): Promise<PluginJobRun | null> {
    void _now;
    const filter: Document = {
      run_id: runId,
      revision: expectedRevision,
      status: "running",
      lease_fence: credential.fence,
      "lease.owner": credential.owner,
      "lease.token": credential.token,
      "lease.fence": credential.fence,
      $expr: mongoTimestampComparison("$lease.expires_at", "$gt"),
    };
    const currentDocument = await this.collection.findOne(filter);
    if (!currentDocument) return null;
    const current = toRun(currentDocument);
    const next = mutate(current);
    if (!sameImmutableFields(current, next)) {
      throw new PluginJobError(
        PLUGIN_JOB_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "任务更新不能改变不可变身份"
      );
    }
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
    const updated = await this.collection.findOneAndUpdate(filter, update, {
      returnDocument: "after",
    });
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
