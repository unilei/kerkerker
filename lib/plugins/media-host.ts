/**
 * Provider-neutral host facades for media capabilities.
 *
 * Plugins return untrusted, provider-owned JSON. These functions are the
 * server-side boundary used by routes, jobs, and repositories: they invoke
 * the active profile and validate/normalize the result before it can be
 * displayed or persisted. No vendor adapter is imported here.
 */

import { assertSafeOutboundUrl } from "@/lib/url-security";
import { getActivePluginProfileId } from "@/lib/plugins/builtin-profiles";
import { createProfileInvocation } from "@/lib/plugins/invocation";
import { invokeProfilePlugin } from "@/lib/plugins/runtime";
import { PluginError } from "@/lib/plugins/errors";
import type {
  DanmuEvent,
  DanmuRequest,
  ImageCandidate,
  ImageRequest,
  PlaybackRequest,
  PlaybackResourceCandidate,
  RecommendationCandidate,
  RecommendationRequest,
} from "@/lib/plugins/types";

const MAX_PLAYBACK_ITEMS = 100;
const MAX_DANMU_ITEMS = 20_000;
const MAX_IMAGE_ITEMS = 100;
const MAX_RECOMMENDATION_ITEMS = 100;
const MAX_TEXT_LENGTH = 2_000;
const CONTENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;

export interface MediaHostExecutionOptions {
  readonly profileId?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function invocation(
  capability:
    | "resource.playback"
    | "interaction.danmu"
    | "asset.image"
    | "recommendation",
  options: MediaHostExecutionOptions
) {
  const profileId = options.profileId || getActivePluginProfileId();
  const { context } = createProfileInvocation({
    profileId,
    capability,
    requestId: options.requestId,
    runId: options.runId,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return { profileId, context };
}

function fail(path: string, message: string): never {
  throw new PluginError("EXECUTION_FAILED", message, { path });
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`limit 必须是 1 到 ${max} 的整数`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, path: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") fail(path, `${path} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail(path, `${path} 格式无效`);
  }
  return normalized;
}

function contentId(value: unknown, path: string): string {
  const normalized = text(value, path, 100);
  if (!CONTENT_ID_PATTERN.test(normalized)) fail(path, `${path} 不是有效 content_id`);
  return normalized;
}

function providerId(value: unknown, path: string): string {
  const normalized = text(value, path, 100).toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalized)) fail(path, `${path} 不是有效 provider_id`);
  return normalized;
}

function availability(value: unknown, path: string): PlaybackResourceCandidate["availability"] {
  if (value === "available" || value === "unavailable" || value === "unknown") return value;
  fail(path, `${path} 状态无效`);
}

function provenance(value: unknown, path: string) {
  if (!isRecord(value) || !isRecord(value.source) ||
      typeof value.pluginVersion !== "string" ||
      !value.pluginVersion.trim() ||
      typeof value.fetchedAt !== "string" ||
      !Number.isFinite(Date.parse(value.fetchedAt)) ||
      typeof value.source.providerId !== "string" ||
      !PROVIDER_ID_PATTERN.test(value.source.providerId)) {
    fail(path, "来源信息结构无效");
  }
  return value as unknown as PlaybackResourceCandidate["provenance"];
}

function optionalIso(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail(path, `${path} 必须是 ISO 时间`);
  }
  return value;
}

async function safeUrl(
  value: unknown,
  path: string,
  options: { requireHttps?: boolean } = {}
): Promise<string> {
  const url = text(value, path, 8_000);
  const parsed = await assertSafeOutboundUrl(url);
  if (options.requireHttps && parsed.protocol !== "https:") {
    fail(path, `${path} 必须使用 HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    fail(path, `${path} 不得包含凭据或 fragment`);
  }
  return url;
}

function canonicalUrl(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = text(value, path, 8_000);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    fail(path, `${path} 必须是 HTTP(S) URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username || parsed.password || parsed.hash) {
    fail(path, `${path} URL 格式无效`);
  }
  return normalized;
}

function arrayResult(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, `${path} 必须是数组`);
  return value;
}

export function normalizePlaybackResources(
  value: unknown,
  request: PlaybackRequest
): Promise<readonly PlaybackResourceCandidate[]> {
  const rows = arrayResult(value, "playback");
  if (rows.length > MAX_PLAYBACK_ITEMS) fail("playback", "播放资源数量超过上限");
  return Promise.all(rows.map(async (raw, index) => {
    const path = `playback[${index}]`;
    if (!isRecord(raw) || raw.kind !== "playback") fail(path, "播放资源结构无效");
    const url = await safeUrl(raw.url, `${path}.url`, { requireHttps: true });
    const expiresAt = optionalIso(raw.expiresAt, `${path}.expiresAt`);
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      // Expired signed URLs must never reach a player. The caller can request
      // a fresh list on the next render/retry.
      return null;
    }
    const candidate: PlaybackResourceCandidate = {
      kind: "playback",
      ...(raw.contentId === undefined
        ? { contentId: request.content.contentId }
        : { contentId: contentId(raw.contentId, `${path}.contentId`) }),
      providerId: providerId(raw.providerId, `${path}.providerId`),
      externalId: text(raw.externalId, `${path}.externalId`, 500),
      title: text(raw.title, `${path}.title`, 500),
      url,
      availability: availability(raw.availability, `${path}.availability`),
      ...(typeof raw.protocol === "string" && raw.protocol.trim()
        ? { protocol: raw.protocol.trim().slice(0, 32) }
        : {}),
      ...(typeof raw.quality === "string" && raw.quality.trim()
        ? { quality: raw.quality.trim().slice(0, 64) }
        : {}),
      ...(Array.isArray(raw.subtitles)
        ? { subtitles: raw.subtitles.slice(0, 20).map((item, subtitleIndex) => text(item, `${path}.subtitles[${subtitleIndex}]`, 500)) }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
      provenance: provenance(raw.provenance, `${path}.provenance`),
    };
    if (candidate.contentId !== request.content.contentId) {
      fail(`${path}.contentId`, "播放资源 content_id 与请求内容不一致");
    }
    return candidate;
  })).then((items) => {
    const seen = new Set<string>();
    return items.filter((item): item is PlaybackResourceCandidate => {
      if (!item) return false;
      const key = `${item.providerId}\u0000${item.externalId}\u0000${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

export function normalizeDanmuEvents(value: unknown): readonly DanmuEvent[] {
  const rows = arrayResult(value, "danmu");
  if (rows.length > MAX_DANMU_ITEMS) fail("danmu", "弹幕数量超过上限");
  const seen = new Set<string>();
  const events: DanmuEvent[] = [];
  rows.forEach((raw, index) => {
    const path = `danmu[${index}]`;
    if (!isRecord(raw)) fail(path, "弹幕结构无效");
    if (!Number.isSafeInteger(raw.timeMs) || (raw.timeMs as number) < 0) {
      fail(`${path}.timeMs`, "弹幕时间必须是非负整数毫秒");
    }
    const event: DanmuEvent = {
      timeMs: raw.timeMs as number,
      text: text(raw.text, `${path}.text`, 500),
      ...(raw.color === undefined
        ? {}
        : typeof raw.color === "string" && /^#[0-9a-f]{3,8}$/i.test(raw.color.trim())
          ? { color: raw.color.trim().toLowerCase() }
          : fail(`${path}.color`, "弹幕颜色必须是十六进制颜色")),
      ...(raw.mode === "scroll" || raw.mode === "top" || raw.mode === "bottom" || raw.mode === "advanced"
        ? { mode: raw.mode }
        : raw.mode === undefined
          ? {}
          : fail(`${path}.mode`, "弹幕模式无效")),
    };
    const key = `${event.timeMs}\u0000${event.text}\u0000${event.color || ""}\u0000${event.mode || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      events.push(event);
    }
  });
  return events.sort((left, right) => left.timeMs - right.timeMs);
}

export async function normalizeImageCandidates(
  value: unknown,
  request: ImageRequest
): Promise<readonly ImageCandidate[]> {
  const rows = arrayResult(value, "images");
  if (rows.length > MAX_IMAGE_ITEMS) fail("images", "图片数量超过上限");
  const seen = new Set<string>();
  const images: ImageCandidate[] = [];
  for (const [index, raw] of rows.entries()) {
    const path = `images[${index}]`;
    if (!isRecord(raw)) fail(path, "图片结构无效");
    const candidateContentId = contentId(raw.contentId, `${path}.contentId`);
    if (candidateContentId !== request.content.contentId) fail(`${path}.contentId`, "图片 content_id 与请求内容不一致");
    const purpose = text(raw.purpose, `${path}.purpose`, 64);
    const url = await safeUrl(raw.url, `${path}.url`);
    const dimension = (value: unknown, name: "width" | "height"): number | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 20_000) {
        fail(`${path}.${name}`, `${path}.${name} 尺寸无效`);
      }
      return value;
    };
    const width = dimension(raw.width, "width");
    const height = dimension(raw.height, "height");
    const key = `${purpose}\u0000${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({
      contentId: candidateContentId,
      purpose,
      url,
      ...(width !== undefined ? { width: width as number } : {}),
      ...(height !== undefined ? { height: height as number } : {}),
      ...(typeof raw.mimeType === "string" && raw.mimeType.trim() ? { mimeType: raw.mimeType.trim().slice(0, 100) } : {}),
      provenance: provenance(raw.provenance, `${path}.provenance`),
    });
  }
  return images;
}

export function normalizeRecommendationCandidates(
  value: unknown,
  request: RecommendationRequest
): readonly RecommendationCandidate[] {
  const rows = arrayResult(value, "recommendations");
  const limit = boundedLimit(request.limit, 20, MAX_RECOMMENDATION_ITEMS);
  if (rows.length > MAX_RECOMMENDATION_ITEMS) fail("recommendations", "推荐数量超过上限");
  const seen = new Set<string>();
  const recommendations: RecommendationCandidate[] = [];
  for (const [index, raw] of rows.entries()) {
    const path = `recommendations[${index}]`;
    if (!isRecord(raw)) fail(path, "推荐结构无效");
    const candidateContentId = raw.contentId === undefined ? undefined : contentId(raw.contentId, `${path}.contentId`);
    const refs = raw.externalRefs;
    if (!candidateContentId && (!Array.isArray(refs) || refs.length === 0)) {
      fail(path, "推荐必须包含 content_id 或外部引用");
    }
    const normalizedRefs = Array.isArray(refs)
      ? refs.slice(0, 8).map((ref, refIndex) => {
          if (!isRecord(ref)) fail(`${path}.externalRefs[${refIndex}]`, "外部引用结构无效");
          return {
            providerId: providerId(ref.providerId, `${path}.externalRefs[${refIndex}].providerId`),
            externalId: text(ref.externalId, `${path}.externalRefs[${refIndex}].externalId`, 500),
            ...(ref.canonicalUrl !== undefined
              ? { canonicalUrl: canonicalUrl(ref.canonicalUrl, `${path}.externalRefs[${refIndex}].canonicalUrl`) }
              : {}),
          };
        })
      : undefined;
    const key = candidateContentId || normalizedRefs?.map((ref) => `${ref.providerId}:${ref.externalId}`).join(",");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const score = raw.score === undefined ? undefined : raw.score;
    if (score !== undefined && (typeof score !== "number" || !Number.isFinite(score))) fail(`${path}.score`, "推荐分数无效");
    recommendations.push({
      ...(candidateContentId ? { contentId: candidateContentId } : {}),
      ...(normalizedRefs ? { externalRefs: normalizedRefs } : {}),
      ...(score !== undefined ? { score: score as number } : {}),
      ...(Array.isArray(raw.reason) ? { reason: raw.reason as RecommendationCandidate["reason"] } : {}),
      provenance: provenance(raw.provenance, `${path}.provenance`),
    });
    if (recommendations.length >= limit) break;
  }
  return recommendations;
}

export async function getPlaybackResources(
  request: PlaybackRequest,
  options: MediaHostExecutionOptions = {}
): Promise<readonly PlaybackResourceCandidate[]> {
  const invocationOptions = invocation("resource.playback", options);
  const result = await invokeProfilePlugin<readonly PlaybackResourceCandidate[]>({
    ...invocationOptions,
    capability: "resource.playback",
    operation: "playback",
    request,
  });
  return normalizePlaybackResources(result, request);
}

export async function getDanmuEvents(
  request: DanmuRequest,
  options: MediaHostExecutionOptions = {}
): Promise<readonly DanmuEvent[]> {
  const invocationOptions = invocation("interaction.danmu", options);
  const result = await invokeProfilePlugin<readonly DanmuEvent[]>({
    ...invocationOptions,
    capability: "interaction.danmu",
    operation: "danmu",
    request,
  });
  return normalizeDanmuEvents(result);
}

export async function getImageCandidates(
  request: ImageRequest,
  options: MediaHostExecutionOptions = {}
): Promise<readonly ImageCandidate[]> {
  const invocationOptions = invocation("asset.image", options);
  const result = await invokeProfilePlugin<readonly ImageCandidate[]>({
    ...invocationOptions,
    capability: "asset.image",
    operation: "image",
    request,
  });
  return normalizeImageCandidates(result, request);
}

export async function getRecommendations(
  request: RecommendationRequest,
  options: MediaHostExecutionOptions = {}
): Promise<readonly RecommendationCandidate[]> {
  const invocationOptions = invocation("recommendation", options);
  const result = await invokeProfilePlugin<readonly RecommendationCandidate[]>({
    ...invocationOptions,
    capability: "recommendation",
    operation: "recommendation",
    request,
  });
  return normalizeRecommendationCandidates(result, request);
}
