import type { Collection, Db, Document, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/lib/constants/db";
import { getDatabase } from "@/lib/db";
import {
  ImageMirrorIdempotencyConflictError,
  type ImageMirrorBeginOptions,
  type ImageMirrorError,
  type ImageMirrorInput,
  type ImageMirrorQuery,
  type ImageMirrorRecord,
  type ImageMirrorRepository,
  IMAGE_MIRROR_STATUSES,
  imageMirrorInternals,
} from "@/lib/plugins/image-mirror";

/** Mongo representation of a host-owned asset.image mirror record. */
export interface ImageMirrorDocument extends Document {
  _id?: ObjectId;
  content_id: string;
  provider_id: string;
  external_id: string;
  purpose: string;
  original_url: string;
  width?: number;
  height?: number;
  mime_type?: string;
  idempotency_key: string;
  object_key: string;
  mirror_url?: string;
  status: ImageMirrorRecord["status"];
  attempt: number;
  error?: ImageMirrorError;
  created_at: string;
  updated_at: string;
  mirrored_at?: string;
  invalidated_at?: string;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
  ) as T;
}

function duplicateKey(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === 11000
  );
}

function toDocument(record: ImageMirrorRecord): ImageMirrorDocument {
  return withoutUndefined({
    content_id: record.contentId,
    provider_id: record.providerId,
    external_id: record.externalId,
    purpose: record.purpose,
    original_url: record.originalUrl,
    width: record.width,
    height: record.height,
    mime_type: record.mimeType,
    idempotency_key: record.idempotencyKey,
    object_key: record.objectKey,
    mirror_url: record.mirrorUrl,
    status: record.status,
    attempt: record.attempt,
    error: record.error
      ? { ...record.error }
      : undefined,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    mirrored_at: record.mirroredAt,
    invalidated_at: record.invalidatedAt,
  }) as ImageMirrorDocument;
}

function toRecord(document: ImageMirrorDocument): ImageMirrorRecord {
  const normalized: ImageMirrorInput = imageMirrorInternals.normalizeImageMirrorInput({
    contentId: document.content_id,
    providerId: document.provider_id,
    externalId: document.external_id,
    purpose: document.purpose,
    originalUrl: document.original_url,
    ...(document.width !== undefined ? { width: document.width } : {}),
    ...(document.height !== undefined ? { height: document.height } : {}),
    ...(document.mime_type ? { mimeType: document.mime_type } : {}),
  });
  const status = IMAGE_MIRROR_STATUSES.includes(document.status)
    ? document.status
    : "failed";
  const attempt = Number.isSafeInteger(document.attempt) && document.attempt >= 0
    ? document.attempt
    : 0;
  const idempotencyKey =
    typeof document.idempotency_key === "string" && document.idempotency_key
      ? document.idempotency_key
      : `image-mirror:invalid-${document._id?.toHexString() || "unknown"}`;
  const objectKey =
    typeof document.object_key === "string" && document.object_key
      ? document.object_key
      : "image-mirrors/invalid";
  const error = document.error && typeof document.error.message === "string"
    ? {
        ...(typeof document.error.code === "string"
          ? { code: document.error.code }
          : {}),
        message: document.error.message,
      }
    : undefined;
  return {
    ...normalized,
    idempotencyKey,
    objectKey,
    ...(typeof document.mirror_url === "string"
      ? { mirrorUrl: document.mirror_url }
      : {}),
    status,
    attempt,
    ...(error ? { error } : {}),
    createdAt:
      typeof document.created_at === "string"
        ? document.created_at
        : imageMirrorInternals.now(),
    updatedAt:
      typeof document.updated_at === "string"
        ? document.updated_at
        : imageMirrorInternals.now(),
    ...(typeof document.mirrored_at === "string"
      ? { mirroredAt: document.mirrored_at }
      : {}),
    ...(typeof document.invalidated_at === "string"
      ? { invalidatedAt: document.invalidated_at }
      : {}),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new RangeError("图片镜像查询 limit 必须是 1 到 500 的整数");
  }
  return value;
}

function normalizeStatuses(
  status: ImageMirrorQuery["status"]
): readonly ImageMirrorRecord["status"][] | undefined {
  if (status === undefined) return undefined;
  const values = Array.isArray(status) ? status : [status];
  if (values.length === 0) throw new RangeError("图片镜像状态不能为空");
  for (const value of values) {
    if (!IMAGE_MIRROR_STATUSES.includes(value)) {
      throw new RangeError("图片镜像状态无效");
    }
  }
  return values;
}

function sameImmutableFields(
  existing: ImageMirrorRecord,
  candidate: ImageMirrorRecord
): boolean {
  return (
    existing.idempotencyKey === candidate.idempotencyKey &&
    existing.contentId === candidate.contentId &&
    existing.providerId === candidate.providerId &&
    existing.externalId === candidate.externalId &&
    existing.purpose === candidate.purpose &&
    existing.originalUrl === candidate.originalUrl
  );
}

/** Mongo-backed repository for host-owned image mirror state. */
export class MongoImageMirrorRepository implements ImageMirrorRepository {
  private indexesPromise: Promise<void> | undefined;

  constructor(
    private readonly collection: Collection<ImageMirrorDocument>
  ) {}

  private ensureIndexes(): Promise<void> {
    if (!this.indexesPromise) {
      this.indexesPromise = Promise.all([
        this.collection.createIndex(
          { idempotency_key: 1 },
          { unique: true, name: "image_mirror_idempotency_key" }
        ),
        this.collection.createIndex(
          { content_id: 1, status: 1, updated_at: -1 },
          { name: "image_mirror_content_status_updated" }
        ),
        this.collection.createIndex(
          { provider_id: 1, external_id: 1, status: 1 },
          { name: "image_mirror_provider_external_status" }
        ),
      ]).then(() => undefined);
    }
    return this.indexesPromise;
  }

  async begin(
    record: ImageMirrorRecord,
    options: ImageMirrorBeginOptions = {}
  ): Promise<{ record: ImageMirrorRecord; shouldMirror: boolean }> {
    await this.ensureIndexes();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existingDocument = await this.collection.findOne({
        idempotency_key: record.idempotencyKey,
      });
      if (!existingDocument) {
        try {
          const created = { ...record, attempt: 1, updatedAt: imageMirrorInternals.now() };
          await this.collection.insertOne(toDocument(created));
          return { record: created, shouldMirror: true };
        } catch (error) {
          if (!duplicateKey(error)) throw error;
          continue;
        }
      }

      const existing = toRecord(existingDocument);
      if (!sameImmutableFields(existing, record)) {
        throw new ImageMirrorIdempotencyConflictError();
      }
      if (existing.status === "mirrored" && !options.force) {
        return { record: existing, shouldMirror: false };
      }
      if (existing.status === "invalidated" && !options.force) {
        return { record: existing, shouldMirror: false };
      }
      if (existing.status === "failed" && options.retryFailed === false) {
        return { record: existing, shouldMirror: false };
      }

      const timestamp = imageMirrorInternals.now();
      const unset: Record<string, ""> = { error: "" };
      if (existing.status === "invalidated" || options.force) {
        unset.mirror_url = "";
        unset.mirrored_at = "";
        unset.invalidated_at = "";
      }
      const updated = await this.collection.findOneAndUpdate(
        {
          idempotency_key: record.idempotencyKey,
          status: existing.status,
        },
        {
          $set: {
            status: "pending",
            attempt: existing.attempt + 1,
            updated_at: timestamp,
          },
          $unset: unset,
        },
        { returnDocument: "after" }
      );
      if (updated) return { record: toRecord(updated), shouldMirror: true };
      // A concurrent worker changed the state. Re-read and apply the same
      // terminal-state rules instead of claiming a stale record.
    }
    throw new Error("图片镜像状态并发更新过于频繁，请重试");
  }

  async getByIdempotencyKey(key: string): Promise<ImageMirrorRecord | null> {
    await this.ensureIndexes();
    const document = await this.collection.findOne({ idempotency_key: key });
    return document ? toRecord(document) : null;
  }

  async markMirrored(
    key: string,
    patch: {
      readonly mirrorUrl: string;
      readonly width?: number;
      readonly height?: number;
      readonly mimeType?: string;
    }
  ): Promise<ImageMirrorRecord | null> {
    await this.ensureIndexes();
    const timestamp = imageMirrorInternals.now();
    const updated = await this.collection.findOneAndUpdate(
      { idempotency_key: key, status: "pending" },
      {
        $set: withoutUndefined({
          status: "mirrored" as const,
          mirror_url: patch.mirrorUrl,
          ...(patch.width !== undefined ? { width: patch.width } : {}),
          ...(patch.height !== undefined ? { height: patch.height } : {}),
          ...(patch.mimeType !== undefined ? { mime_type: patch.mimeType } : {}),
          updated_at: timestamp,
          mirrored_at: timestamp,
        }),
        $unset: { error: "", invalidated_at: "" },
      },
      { returnDocument: "after" }
    );
    return updated ? toRecord(updated) : null;
  }

  async markFailed(
    key: string,
    error: ImageMirrorError
  ): Promise<ImageMirrorRecord | null> {
    await this.ensureIndexes();
    const updated = await this.collection.findOneAndUpdate(
      { idempotency_key: key, status: "pending" },
      {
        $set: {
          status: "failed",
          error: imageMirrorInternals.boundedError(error),
          updated_at: imageMirrorInternals.now(),
        },
      },
      { returnDocument: "after" }
    );
    return updated ? toRecord(updated) : null;
  }

  async invalidate(
    key: string,
    reason?: string
  ): Promise<ImageMirrorRecord | null> {
    await this.ensureIndexes();
    const timestamp = imageMirrorInternals.now();
    const updated = await this.collection.findOneAndUpdate(
      { idempotency_key: key },
      {
        $set: {
          status: "invalidated",
          updated_at: timestamp,
          invalidated_at: timestamp,
          ...(reason
            ? { error: imageMirrorInternals.boundedError({ message: reason }) }
            : {}),
        },
      },
      { returnDocument: "after" }
    );
    return updated ? toRecord(updated) : null;
  }

  async list(query: ImageMirrorQuery = {}): Promise<readonly ImageMirrorRecord[]> {
    await this.ensureIndexes();
    const statuses = normalizeStatuses(query.status);
    const filter: Document = {};
    if (query.contentId) filter.content_id = query.contentId;
    if (query.providerId) filter.provider_id = query.providerId;
    if (query.externalId) filter.external_id = query.externalId;
    if (statuses) filter.status = { $in: statuses };
    const documents = await this.collection
      .find(filter)
      .sort({ updated_at: -1, idempotency_key: 1 })
      .limit(normalizeLimit(query.limit))
      .toArray();
    return documents.map(toRecord);
  }
}

export function createMongoImageMirrorRepository(db: Db): MongoImageMirrorRepository {
  return new MongoImageMirrorRepository(
    db.collection<ImageMirrorDocument>(COLLECTIONS.IMAGE_MIRRORS)
  );
}

export async function getMongoImageMirrorRepository(): Promise<MongoImageMirrorRepository> {
  return createMongoImageMirrorRepository(await getDatabase());
}
