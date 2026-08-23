import { createHash } from "node:crypto";

import { assertSafeOutboundUrl } from "@/lib/url-security";
import type { ExternalReference, ImageCandidate } from "@/lib/plugins/types";

const CONTENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;
const MAX_EXTERNAL_ID_LENGTH = 500;
const MAX_PURPOSE_LENGTH = 64;
const MAX_MIME_TYPE_LENGTH = 100;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export const IMAGE_MIRROR_STATUSES = [
  "pending",
  "mirrored",
  "failed",
  "invalidated",
] as const;
export type ImageMirrorStatus = (typeof IMAGE_MIRROR_STATUSES)[number];

export interface ImageMirrorInput {
  readonly contentId: string;
  readonly providerId: string;
  readonly externalId: string;
  readonly purpose: string;
  readonly originalUrl: string;
  readonly width?: number;
  readonly height?: number;
  readonly mimeType?: string;
}

export interface ImageMirrorError {
  readonly code?: string;
  readonly message: string;
}

export interface ImageMirrorRecord extends ImageMirrorInput {
  readonly idempotencyKey: string;
  readonly objectKey: string;
  readonly mirrorUrl?: string;
  readonly status: ImageMirrorStatus;
  readonly attempt: number;
  readonly error?: ImageMirrorError;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mirroredAt?: string;
  readonly invalidatedAt?: string;
}

export interface ImageMirrorQuery {
  readonly contentId?: string;
  readonly providerId?: string;
  readonly externalId?: string;
  readonly status?: ImageMirrorStatus | readonly ImageMirrorStatus[];
  readonly limit?: number;
}

export interface ImageMirrorBeginOptions {
  /** Retry a previous failed attempt. Defaults to true. */
  readonly retryFailed?: boolean;
  /** Re-fetch an invalidated or mirrored record deliberately. */
  readonly force?: boolean;
}

export interface ImageMirrorBeginResult {
  readonly record: ImageMirrorRecord;
  /** False means the caller should use the existing terminal record. */
  readonly shouldMirror: boolean;
}

export interface ImageMirrorRepository {
  begin(
    record: ImageMirrorRecord,
    options?: ImageMirrorBeginOptions
  ): Promise<ImageMirrorBeginResult>;
  getByIdempotencyKey(key: string): Promise<ImageMirrorRecord | null>;
  markMirrored(
    key: string,
    patch: {
      readonly mirrorUrl: string;
      readonly width?: number;
      readonly height?: number;
      readonly mimeType?: string;
    }
  ): Promise<ImageMirrorRecord | null>;
  markFailed(key: string, error: ImageMirrorError): Promise<ImageMirrorRecord | null>;
  invalidate(key: string, reason?: string): Promise<ImageMirrorRecord | null>;
  list(query?: ImageMirrorQuery): Promise<readonly ImageMirrorRecord[]>;
}

export interface ImageMirrorFetchResult {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ImageMirrorFetcher {
  fetch(
    url: string,
    options: { readonly signal?: AbortSignal; readonly maxBytes: number }
  ): Promise<ImageMirrorFetchResult>;
}

export interface ImageMirrorObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly cacheControl?: string;
}

export interface ImageMirrorObjectStore {
  put(object: ImageMirrorObject): Promise<{ readonly mirrorUrl: string }>;
}

export interface ImageMirrorServiceOptions {
  readonly repository: ImageMirrorRepository;
  readonly objectStore: ImageMirrorObjectStore;
  readonly fetcher?: ImageMirrorFetcher;
  readonly maxImageBytes?: number;
  /** Inject URL policy in tests or a deployment-specific network boundary. */
  readonly assertUrl?: (url: string) => Promise<URL>;
  readonly cacheControl?: string;
}

export class ImageMirrorIdempotencyConflictError extends Error {
  constructor() {
    super("图片镜像幂等键已经绑定到不同的来源或原图");
    this.name = "ImageMirrorIdempotencyConflictError";
  }
}

export class ImageMirrorStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageMirrorStateError";
  }
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new RangeError(`${field} 格式无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RangeError(`${field} 格式无效`);
  }
  return normalized;
}

function normalizeContentId(value: unknown): string {
  const normalized = boundedText(value, "contentId", 100);
  if (!CONTENT_ID_PATTERN.test(normalized)) throw new RangeError("contentId 格式无效");
  return normalized;
}

function normalizeProviderId(value: unknown): string {
  const normalized = boundedText(value, "providerId", 100).toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalized)) throw new RangeError("providerId 格式无效");
  return normalized;
}

function normalizeExternalId(value: unknown): string {
  return boundedText(value, "externalId", MAX_EXTERNAL_ID_LENGTH);
}

function normalizePurpose(value: unknown): string {
  return boundedText(value, "purpose", MAX_PURPOSE_LENGTH);
}

function normalizeOriginalUrl(value: unknown): string {
  const normalized = boundedText(value, "originalUrl", 8_000);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new RangeError("originalUrl 必须是 HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new RangeError("originalUrl URL 格式无效");
  }
  return parsed.toString();
}

function normalizeMirrorUrl(value: unknown): string {
  const normalized = boundedText(value, "mirrorUrl", 8_000);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new RangeError("mirrorUrl 必须是 HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new RangeError("mirrorUrl URL 格式无效");
  }
  return parsed.toString();
}

function normalizeDimension(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 20_000) {
    throw new RangeError(`${field} 必须是 1 到 20000 的整数`);
  }
  return Number(value);
}

function normalizeMimeType(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = boundedText(value, "mimeType", MAX_MIME_TYPE_LENGTH).toLowerCase();
  if (!normalized.startsWith("image/")) throw new RangeError("mimeType 必须是 image/*");
  return normalized;
}

export function normalizeImageMirrorInput(input: ImageMirrorInput): ImageMirrorInput {
  const width = normalizeDimension(input.width, "width");
  const height = normalizeDimension(input.height, "height");
  const mimeType = normalizeMimeType(input.mimeType);
  return {
    contentId: normalizeContentId(input.contentId),
    providerId: normalizeProviderId(input.providerId),
    externalId: normalizeExternalId(input.externalId),
    purpose: normalizePurpose(input.purpose),
    originalUrl: normalizeOriginalUrl(input.originalUrl),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function digestFor(input: ImageMirrorInput): string {
  return createHash("sha256")
    .update(
      [input.contentId, input.providerId, input.externalId, input.purpose, input.originalUrl].join("\u001f")
    )
    .digest("hex");
}

export function imageMirrorIdempotencyKey(input: ImageMirrorInput): string {
  return `image-mirror:${digestFor(normalizeImageMirrorInput(input))}`;
}

export function imageMirrorObjectKey(input: ImageMirrorInput): string {
  const normalized = normalizeImageMirrorInput(input);
  return `image-mirrors/${normalized.providerId}/${digestFor(normalized)}${extensionFor(
    normalized.originalUrl,
    normalized.mimeType
  )}`;
}

function extensionFor(originalUrl: string, mimeType?: string): string {
  const pathExtension = (() => {
    try {
      const path = new URL(originalUrl).pathname.toLowerCase();
      const match = /\.(jpg|jpeg|png|webp|gif|avif|bmp)$/.exec(path);
      return match ? `.${match[1]}` : "";
    } catch {
      return "";
    }
  })();
  if (pathExtension) return pathExtension;
  const mimeExtension: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
  };
  return mimeExtension[mimeType || ""] || ".img";
}

function now(): string {
  return new Date().toISOString();
}

function cloneRecord(record: ImageMirrorRecord): ImageMirrorRecord {
  return {
    ...record,
    ...(record.error ? { error: { ...record.error } } : {}),
  };
}

function sameImmutableInput(left: ImageMirrorRecord, right: ImageMirrorRecord): boolean {
  return left.idempotencyKey === right.idempotencyKey &&
    left.contentId === right.contentId &&
    left.providerId === right.providerId &&
    left.externalId === right.externalId &&
    left.purpose === right.purpose &&
    left.originalUrl === right.originalUrl;
}

function initialRecord(input: ImageMirrorInput): ImageMirrorRecord {
  const normalized = normalizeImageMirrorInput(input);
  const key = imageMirrorIdempotencyKey(normalized);
  const timestamp = now();
  return {
    ...normalized,
    idempotencyKey: key,
    objectKey: imageMirrorObjectKey(normalized),
    status: "pending",
    attempt: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function boundedError(error: unknown): ImageMirrorError {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message)
      : String(error);
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "").trim()
    : "";
  return {
    ...(code ? { code: code.slice(0, 80) } : {}),
    message: message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) || "图片镜像失败",
  };
}

/** In-memory repository used by unit tests and local dry-runs. */
export class InMemoryImageMirrorRepository implements ImageMirrorRepository {
  private readonly records = new Map<string, ImageMirrorRecord>();

  async begin(
    record: ImageMirrorRecord,
    options: ImageMirrorBeginOptions = {}
  ): Promise<ImageMirrorBeginResult> {
    const existing = this.records.get(record.idempotencyKey);
    if (!existing) {
      const created = { ...record, attempt: 1, updatedAt: now() };
      this.records.set(record.idempotencyKey, created);
      return { record: cloneRecord(created), shouldMirror: true };
    }
    if (!sameImmutableInput(existing, record)) throw new ImageMirrorIdempotencyConflictError();
    if (existing.status === "mirrored" && !options.force) {
      return { record: cloneRecord(existing), shouldMirror: false };
    }
    if (existing.status === "invalidated" && !options.force) {
      return { record: cloneRecord(existing), shouldMirror: false };
    }
    if (existing.status === "failed" && options.retryFailed === false) {
      return { record: cloneRecord(existing), shouldMirror: false };
    }
    const pending: ImageMirrorRecord = {
      ...existing,
      status: "pending",
      attempt: existing.attempt + 1,
      updatedAt: now(),
      ...(existing.error ? { error: undefined } : {}),
      ...(existing.status === "invalidated" || options.force
        ? { mirrorUrl: undefined, mirroredAt: undefined, invalidatedAt: undefined }
        : {}),
    };
    this.records.set(record.idempotencyKey, pending);
    return { record: cloneRecord(pending), shouldMirror: true };
  }

  async getByIdempotencyKey(key: string): Promise<ImageMirrorRecord | null> {
    const record = this.records.get(key);
    return record ? cloneRecord(record) : null;
  }

  async markMirrored(
    key: string,
    patch: { mirrorUrl: string; width?: number; height?: number; mimeType?: string }
  ): Promise<ImageMirrorRecord | null> {
    const existing = this.records.get(key);
    if (!existing || existing.status !== "pending") return null;
    const updated: ImageMirrorRecord = {
      ...existing,
      status: "mirrored",
      mirrorUrl: patch.mirrorUrl,
      ...(patch.width !== undefined ? { width: patch.width } : {}),
      ...(patch.height !== undefined ? { height: patch.height } : {}),
      ...(patch.mimeType !== undefined ? { mimeType: patch.mimeType } : {}),
      updatedAt: now(),
      mirroredAt: now(),
      error: undefined,
      invalidatedAt: undefined,
    };
    this.records.set(key, updated);
    return cloneRecord(updated);
  }

  async markFailed(key: string, error: ImageMirrorError): Promise<ImageMirrorRecord | null> {
    const existing = this.records.get(key);
    if (!existing || existing.status !== "pending") return null;
    const updated: ImageMirrorRecord = {
      ...existing,
      status: "failed",
      error: boundedError(error),
      updatedAt: now(),
    };
    this.records.set(key, updated);
    return cloneRecord(updated);
  }

  async invalidate(key: string, reason?: string): Promise<ImageMirrorRecord | null> {
    const existing = this.records.get(key);
    if (!existing) return null;
    const timestamp = now();
    const updated: ImageMirrorRecord = {
      ...existing,
      status: "invalidated",
      updatedAt: timestamp,
      invalidatedAt: timestamp,
      ...(reason ? { error: boundedError({ message: reason }) } : {}),
    };
    this.records.set(key, updated);
    return cloneRecord(updated);
  }

  async list(query: ImageMirrorQuery = {}): Promise<readonly ImageMirrorRecord[]> {
    const statuses = query.status
      ? new Set(Array.isArray(query.status) ? query.status : [query.status])
      : undefined;
    const limit = Math.min(Math.max(query.limit || 100, 1), 500);
    return [...this.records.values()]
      .filter((record) => !query.contentId || record.contentId === query.contentId)
      .filter((record) => !query.providerId || record.providerId === query.providerId)
      .filter((record) => !query.externalId || record.externalId === query.externalId)
      .filter((record) => !statuses || statuses.has(record.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(cloneRecord);
  }
}

async function defaultFetchImage(
  url: string,
  options: { signal?: AbortSignal; maxBytes: number }
): Promise<ImageMirrorFetchResult> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new Error(`图片源返回 HTTP ${response.status}`);
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) throw new Error("图片源返回了非图片内容");
  const length = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > options.maxBytes) throw new Error("图片超过大小限制");
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length === 0 || body.length > options.maxBytes) throw new Error("图片大小无效或超过限制");
  return { body, contentType };
}

export class ImageMirrorService {
  private readonly repository: ImageMirrorRepository;
  private readonly objectStore: ImageMirrorObjectStore;
  private readonly fetcher: ImageMirrorFetcher;
  private readonly maxImageBytes: number;
  private readonly assertUrl: (url: string) => Promise<URL>;
  private readonly cacheControl: string;
  private readonly inFlight = new Map<string, Promise<ImageMirrorRecord>>();

  constructor(options: ImageMirrorServiceOptions) {
    this.repository = options.repository;
    this.objectStore = options.objectStore;
    this.fetcher = options.fetcher || { fetch: defaultFetchImage };
    this.maxImageBytes = options.maxImageBytes || DEFAULT_MAX_IMAGE_BYTES;
    if (!Number.isSafeInteger(this.maxImageBytes) || this.maxImageBytes < 1) {
      throw new RangeError("maxImageBytes 必须是正整数");
    }
    this.assertUrl = options.assertUrl || ((url) => assertSafeOutboundUrl(url));
    this.cacheControl = options.cacheControl || DEFAULT_CACHE_CONTROL;
  }

  async mirror(
    input: ImageMirrorInput,
    options: ImageMirrorBeginOptions & { readonly signal?: AbortSignal } = {}
  ): Promise<ImageMirrorRecord> {
    const normalized = normalizeImageMirrorInput(input);
    const key = imageMirrorIdempotencyKey(normalized);
    const active = this.inFlight.get(key);
    if (active) return active;
    const promise = this.mirrorOnce(normalized, options).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  async invalidate(key: string, reason?: string): Promise<ImageMirrorRecord | null> {
    return this.repository.invalidate(key, reason);
  }

  async list(query?: ImageMirrorQuery): Promise<readonly ImageMirrorRecord[]> {
    return this.repository.list(query);
  }

  private async mirrorOnce(
    input: ImageMirrorInput,
    options: ImageMirrorBeginOptions & { readonly signal?: AbortSignal }
  ): Promise<ImageMirrorRecord> {
    const pending = initialRecord(input);
    const begun = await this.repository.begin(pending, options);
    if (!begun.shouldMirror) return begun.record;
    try {
      await this.assertUrl(input.originalUrl);
      const fetched = await this.fetcher.fetch(input.originalUrl, {
        signal: options.signal,
        maxBytes: this.maxImageBytes,
      });
      if (!(fetched.body instanceof Uint8Array) || fetched.body.length === 0 || fetched.body.length > this.maxImageBytes) {
        throw new Error("图片大小无效或超过限制");
      }
      const contentType = (fetched.contentType || input.mimeType || "").split(";", 1)[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) throw new Error("图片 MIME 类型无效");
      const uploaded = await this.objectStore.put({
        key: pending.objectKey,
        body: fetched.body,
        contentType,
        cacheControl: this.cacheControl,
      });
      const mirrored = await this.repository.markMirrored(pending.idempotencyKey, {
        mirrorUrl: normalizeMirrorUrl(uploaded.mirrorUrl),
        ...(fetched.width !== undefined || input.width !== undefined
          ? { width: fetched.width ?? input.width }
          : {}),
        ...(fetched.height !== undefined || input.height !== undefined
          ? { height: fetched.height ?? input.height }
          : {}),
        mimeType: contentType,
      });
      if (!mirrored) {
        const current = await this.repository.getByIdempotencyKey(pending.idempotencyKey);
        if (current) return current;
        throw new ImageMirrorStateError("图片镜像状态在上传后消失");
      }
      return mirrored;
    } catch (error) {
      const failed = await this.repository.markFailed(pending.idempotencyKey, boundedError(error));
      if (failed) return failed;
      const current = await this.repository.getByIdempotencyKey(pending.idempotencyKey);
      if (current) return current;
      throw error;
    }
  }
}

/** Map a normalized plugin image candidate to an explicit source identity. */
export function imageMirrorInputFromCandidate(
  candidate: ImageCandidate,
  source: ExternalReference
): ImageMirrorInput {
  if (!CONTENT_ID_PATTERN.test(candidate.contentId)) {
    throw new RangeError("图片候选缺少有效 content_id");
  }
  return {
    contentId: candidate.contentId,
    providerId: source.providerId,
    externalId: source.externalId,
    purpose: candidate.purpose,
    originalUrl: candidate.url,
    ...(candidate.width !== undefined ? { width: candidate.width } : {}),
    ...(candidate.height !== undefined ? { height: candidate.height } : {}),
    ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
  };
}

export interface HttpImageMirrorObjectStoreOptions {
  readonly uploadApiUrl: string;
  readonly publicBaseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

/** Adapter for the existing authenticated Cloudflare image-upload Worker. */
export function createHttpImageMirrorObjectStore(
  options: HttpImageMirrorObjectStoreOptions
): ImageMirrorObjectStore {
  const uploadApiUrl = normalizeBaseUrl(options.uploadApiUrl, "uploadApiUrl");
  const publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl, "publicBaseUrl");
  const token = boundedText(options.token, "token", 500);
  const request = options.fetch || fetch;
  return {
    async put(object) {
      const path = object.key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
      const response = await request(`${uploadApiUrl}/${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": object.contentType,
          "Cache-Control": object.cacheControl || DEFAULT_CACHE_CONTROL,
        },
        body: Buffer.from(object.body),
      });
      if (!response.ok) {
        throw new Error(`图片镜像上传 Worker 返回 HTTP ${response.status}`);
      }
      return { mirrorUrl: `${publicBaseUrl}/${path}` };
    },
  };
}

function normalizeBaseUrl(value: unknown, field: string): string {
  const normalized = boundedText(value, field, 2_000).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new RangeError(`${field} 必须是 HTTP(S) URL`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.hash) {
    throw new RangeError(`${field} URL 格式无效`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

// Keep these helpers available to the Mongo adapter without exposing mutable
// implementation details as part of the public plugin contract.
export const imageMirrorInternals = {
  boundedError,
  cloneRecord,
  initialRecord,
  normalizeImageMirrorInput,
  sameImmutableInput,
  now,
};
