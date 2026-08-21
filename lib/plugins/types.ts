/**
 * Framework-neutral plugin contract.
 *
 * This module intentionally contains types only.  It must remain usable by a
 * built-in adapter, a package adapter, or a remote sidecar without importing
 * Next.js, MongoDB, React, or a vendor SDK.
 */

import {
  PLUGIN_CAPABILITIES as PUBLIC_PLUGIN_CAPABILITIES,
  PLUGIN_CONTRACT_VERSION as PUBLIC_PLUGIN_CONTRACT_VERSION,
  type ExternalReference as PublicExternalReference,
  type HostContentReference as PublicHostContentReference,
  type PluginCapabilityDeclaration as PublicPluginCapabilityDeclaration,
  type PluginCapabilityId,
  type PluginContractVersion as PublicPluginContractVersion,
  type PluginPage as PublicPluginPage,
  type PluginPageConsistency as PublicPluginPageConsistency,
  type PluginRuntime as PublicPluginRuntime,
  type PluginRuntimeAuth as PublicPluginRuntimeAuth,
  type PluginRuntimeHealth as PublicPluginRuntimeHealth,
  type PluginRuntimeMode as PublicPluginRuntimeMode,
} from "@/packages/kerkerker-plugin-contract/src/index";

export const PLUGIN_CONTRACT_VERSION = PUBLIC_PLUGIN_CONTRACT_VERSION;

/** Contract versions may omit patch when referring to a compatible API line. */
export type PluginContractVersion = PublicPluginContractVersion;

/** Stable capability identifiers.  Provider names must never become IDs. */
export type PluginCapability = PluginCapabilityId;

export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = PUBLIC_PLUGIN_CAPABILITIES;

export type CloudDriveFeature = "search" | "incremental" | "availability";

export type PluginOperation =
  | "catalog"
  | "calendar"
  | "detail"
  | "search"
  | "incremental"
  | "availability"
  | "playback"
  | "danmu"
  | "image"
  | "recommendation";

export const CLOUD_DRIVE_FEATURES: readonly CloudDriveFeature[] = [
  "search",
  "incremental",
  "availability",
] as const;

export type PluginRuntimeMode = PublicPluginRuntimeMode;

export type PluginRuntimeHealth = PublicPluginRuntimeHealth;

export type PluginRuntimeAuth = PublicPluginRuntimeAuth;

/** The entry is a module specifier for local runtimes and an HTTP(S) URL for a remote runtime. */
export type PluginRuntime = PublicPluginRuntime;

export type PluginCapabilityDeclaration = PublicPluginCapabilityDeclaration;

/** Authoring input is intentionally versioned; bare capability strings are not loadable. */
export type PluginCapabilityInput = PluginCapabilityDeclaration;

export type PluginConfigFieldType =
  | "string"
  | "number"
  | "boolean"
  | "url"
  | "secret"
  | "select";

export interface PluginConfigFieldSummary {
  readonly key: string;
  readonly type: PluginConfigFieldType;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly description?: string;
  readonly options?: readonly string[];
}

export interface PluginConfigSchemaSummary {
  readonly version: string;
  readonly fields: readonly PluginConfigFieldSummary[];
}

export type PluginDataClassification =
  | "public"
  | "licensed"
  | "restricted"
  | "personal"
  | "sensitive";

export interface PluginComplianceDeclaration {
  /** The legal or contractual basis for collecting/processing the data. */
  readonly legalBasis: string;
  readonly termsUrl?: string;
  readonly owner?: string;
  readonly authorizationRef?: string;
  readonly dataPurpose?: string | readonly string[];
  readonly retentionDays?: number;
  readonly correctionContact?: { readonly name?: string; readonly email?: string; readonly url?: string } | string;
  readonly takedownContact?: { readonly name?: string; readonly email?: string; readonly url?: string } | string;
  /** A concise description, or a list, of the data/content covered by the plugin. */
  readonly contentScope: string | readonly string[];
  /** ISO 3166-1 alpha-2 codes, or an explicit deployment region label. */
  readonly regions: readonly string[];
  readonly dataClassification: string;
}

export type PluginStoragePermission =
  | "none"
  | "ephemeral"
  | "namespaced"
  | "persistent";

export interface PluginPermissions {
  /** Exact host names (or exact HTTP(S) origins), never wildcard patterns. */
  readonly networkHosts: readonly string[];
  /** Names of secrets made available by the host; values never belong in a manifest. */
  readonly secrets: readonly string[];
  readonly storage: PluginStoragePermission;
}

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly contractVersion: PluginContractVersion;
  readonly runtime: PluginRuntime;
  readonly capabilities: readonly PluginCapabilityDeclaration[];
  readonly locales: readonly string[];
  readonly config: PluginConfigSchemaSummary;
  readonly compliance: PluginComplianceDeclaration;
  readonly permissions: PluginPermissions;
}

/** Convenient authoring input; registries should require versioned declarations before loading. */
export interface PluginManifestInput
  extends Omit<PluginManifest, "capabilities" | "contractVersion"> {
  readonly contractVersion: string;
  readonly capabilities: readonly PluginCapabilityInput[];
}

export type ContentType =
  | "movie"
  | "series"
  | "season"
  | "episode"
  | "person";

export interface PluginSourceRef {
  /** The plugin/provider that produced the value. */
  readonly providerId: string;
  /** Optional upstream source partition when one provider fronts multiple sources. */
  readonly sourceId?: string;
  readonly sourceUrl?: string;
}

/** A platform/brand is the destination or product represented by a resource. */
export interface ResourcePlatformRef {
  readonly platformId: string;
  readonly brand?: string;
  readonly displayName?: string;
}

export type ProviderRef = PluginSourceRef;
export type SourceRef = PluginSourceRef;
export type PlatformRef = ResourcePlatformRef;

/** External IDs are provider-owned; only the host can create contentId. */
export type ExternalReference = PublicExternalReference;

export type HostContentReference = PublicHostContentReference;

export interface LocalizedText {
  readonly locale: string;
  readonly value: string;
}

export type LocalizedValue = readonly LocalizedText[];

/** Small, provider-neutral preview fields safe for search/catalog cards. */
export interface ContentPreview {
  readonly posterUrl?: string;
  readonly backdropUrl?: string;
  readonly rating?: string;
  readonly url?: string;
  readonly episodeInfo?: string;
  readonly genres?: readonly string[];
}

export interface PluginRuntimeProfile {
  readonly locale: string;
  readonly region: string;
  readonly profile: string;
}

export interface ResultProvenance {
  readonly source: PluginSourceRef;
  readonly pluginVersion: string;
  readonly fetchedAt: string;
  readonly sourceUrl?: string;
}

export interface ContentCandidate {
  readonly type: ContentType;
  readonly externalRefs: readonly ExternalReference[];
  readonly titles: LocalizedValue;
  readonly preview?: ContentPreview;
  readonly overview?: LocalizedValue;
  readonly releaseDate?: string;
  readonly region?: string;
  readonly parentRefs?: readonly ExternalReference[];
  readonly provenance: ResultProvenance;
}

/** Host-declared catalog layouts. Plugins map these views to provider APIs. */
export type ContentCatalogView =
  | "category"
  | "featured"
  | "new-releases"
  | "sections"
  | "latest";

/** Stable sort intents understood by the host; provider sort tokens stay in adapters. */
export type ContentCatalogSort = "recommended" | "release-date" | "rating";

/** Provider-neutral filters accepted by list-style catalog views. */
export interface ContentCatalogFilters {
  readonly contentType?: Extract<ContentType, "movie" | "series">;
  readonly genre?: string;
  readonly year?: string;
  readonly region?: string;
  readonly sort?: ContentCatalogSort;
}

/** Optional grouping metadata for section-based catalog views. */
export interface ContentCatalogSection {
  readonly key: string;
  readonly titles: LocalizedValue;
}

export interface ContentCatalogCandidate extends ContentCandidate {
  readonly catalog?: {
    readonly section?: ContentCatalogSection;
  };
}

/** Schedule-specific metadata kept separate from content identity fields. */
export interface ContentCalendarData {
  /** Stable upstream event key; it is not a content_id or a series identity. */
  readonly eventId: string;
  readonly airDate: string;
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  readonly episodeName?: string;
  readonly posterUrl?: string;
  readonly backdropUrl?: string;
  readonly rating?: number;
}

export interface ContentCalendarCandidate extends ContentCandidate {
  readonly calendar: ContentCalendarData;
}

/** Provider-neutral detail fields selected for the active locale/profile. */
export interface ContentPhoto {
  readonly id: string;
  readonly url: string;
  readonly thumbUrl?: string;
}

export interface ContentComment {
  readonly id: string;
  readonly content: string;
  readonly author: string;
}

export interface ContentRecommendation {
  readonly externalRefs: readonly ExternalReference[];
  readonly titles: LocalizedValue;
  readonly posterUrl?: string;
  readonly rating?: string;
}

export interface ContentDetailData {
  readonly rating?: string;
  readonly genres?: readonly string[];
  readonly directors?: readonly string[];
  readonly actors?: readonly string[];
  readonly duration?: string;
  readonly episodeCount?: string;
  readonly shortComment?: ContentComment;
  readonly photos?: readonly ContentPhoto[];
  readonly comments?: readonly ContentComment[];
  readonly recommendations?: readonly ContentRecommendation[];
}

export interface ContentDetailCandidate extends ContentCandidate {
  readonly details: ContentDetailData;
}

export interface CanonicalResourceCandidate {
  /**
   * Host-assigned association. A plugin must not mint or change this value.
   * Discovery/incremental operations may leave it unset until the host's
   * identity resolver matches the external content reference.
   */
  readonly contentId?: string;
  readonly providerId: string;
  readonly externalId: string;
  readonly title: string;
  /**
   * Normalized source-facing name, when the provider exposes one. The host
   * keeps this separate from the display title so compatibility importers can
   * still parse year/format metadata without depending on raw provider data.
   */
  readonly sourceName?: string;
  readonly platform?: ResourcePlatformRef;
  readonly availability: "available" | "unavailable" | "unknown";
  /** Provider-owned update time; distinct from the host persistence timestamp. */
  readonly sourceUpdatedAt?: string;
  readonly expiresAt?: string;
  readonly provenance: ResultProvenance;
}

export interface CloudDriveResourceCandidate extends CanonicalResourceCandidate {
  readonly kind: "cloud-drive";
  readonly platform: ResourcePlatformRef;
  readonly url: string;
  readonly accessCode?: string;
  readonly format?: string;
  readonly sizeBytes?: number;
}

export interface PlaybackResourceCandidate extends CanonicalResourceCandidate {
  readonly kind: "playback";
  readonly url: string;
  readonly protocol?: "hls" | "dash" | "http" | "https" | string;
  readonly quality?: string;
  readonly subtitles?: readonly string[];
}

export interface DanmuEvent {
  readonly timeMs: number;
  readonly text: string;
  readonly color?: string;
  readonly mode?: "scroll" | "top" | "bottom" | "advanced";
}

export interface ImageCandidate {
  readonly contentId: string;
  readonly purpose: "poster" | "backdrop" | "still" | "avatar" | "logo" | string;
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
  readonly mimeType?: string;
  readonly provenance: ResultProvenance;
}

export interface RecommendationCandidate {
  /** Host-assigned ID when the recommendation has already been resolved. */
  readonly contentId?: string;
  /** Provider reference used before the host identity resolver creates contentId. */
  readonly externalRefs?: readonly ExternalReference[];
  readonly score?: number;
  readonly reason?: LocalizedValue;
  readonly provenance: ResultProvenance;
}

export type PluginPage<T> = PublicPluginPage<T>;

export type PluginPageConsistency = PublicPluginPageConsistency;

export interface PluginLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface PluginSecretReader {
  get(name: string): string | undefined;
}

export interface PluginStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Server-only invocation context.  The host creates this object; plugins must
 * not infer locale, region, credentials, or cancellation state from globals.
 */
export interface PluginContext {
  readonly runtime: "server";
  readonly requestId: string;
  readonly runId?: string;
  readonly profile: string;
  readonly locale: string;
  readonly region: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: PluginSecretReader;
  readonly storage: PluginStorage;
  readonly logger: PluginLogger;
}

export type ServerPluginContext = PluginContext;

export interface ContentCatalogRequest {
  readonly view?: ContentCatalogView;
  /** Provider-neutral selection key used by category-style views. */
  readonly key?: string;
  /** @deprecated Compatibility alias for key during the host migration. */
  readonly category?: string;
  readonly cursor?: string;
  readonly limit?: number;
  /** Only host-declared filter fields are forwarded to a catalog plugin. */
  readonly filters?: ContentCatalogFilters;
  readonly updatedSince?: string;
}

export interface ContentCalendarRequest {
  readonly from: string;
  readonly to: string;
  readonly region?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ContentDetailRequest {
  /** Required for persistence-oriented operations; optional for read-only lookup. */
  readonly content?: HostContentReference;
  readonly externalRef?: ExternalReference;
}

export interface ContentSearchRequest {
  readonly query: string;
  /** Interactive UI may merge result sources; resource matching preserves provider suggestion order. */
  readonly intent?: "interactive" | "resource-match";
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CloudDriveSearchRequest {
  /**
   * Present when the host already knows the target content. Manual discovery
   * may search by title first and bind the candidate only during import.
   */
  readonly content?: HostContentReference;
  /** Resolved title used only as an upstream search hint; identity uses stable IDs. */
  readonly title: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CloudDriveIncrementalRequest {
  readonly cursor?: string;
  readonly updatedSince?: string;
  readonly limit?: number;
}

export interface CloudDriveAvailabilityRequest {
  readonly resources: readonly CloudDriveResourceCandidate[];
}

export interface PlaybackRequest {
  readonly content: HostContentReference;
  readonly episode?: number;
}

export interface DanmuRequest {
  readonly content: HostContentReference;
  readonly episode?: number;
}

export interface ImageRequest {
  readonly content: HostContentReference;
  readonly purpose: ImageCandidate["purpose"];
}

export interface RecommendationRequest {
  readonly content?: HostContentReference;
  readonly limit?: number;
}

export interface ContentCatalogCapability {
  catalog(
    context: PluginContext,
    request: ContentCatalogRequest
  ): Promise<PluginPage<ContentCatalogCandidate>>;
}

export interface ContentCalendarCapability {
  calendar(
    context: PluginContext,
    request: ContentCalendarRequest
  ): Promise<PluginPage<ContentCalendarCandidate>>;
}

export interface ContentDetailCapability {
  detail(
    context: PluginContext,
    request: ContentDetailRequest
  ): Promise<ContentDetailCandidate | null>;
}

export interface ContentSearchCapability {
  search(
    context: PluginContext,
    request: ContentSearchRequest
  ): Promise<PluginPage<ContentCandidate>>;
}

export interface CloudDriveSearchCapability {
  search(
    context: PluginContext,
    request: CloudDriveSearchRequest
  ): Promise<PluginPage<CloudDriveResourceCandidate>>;
}

export interface CloudDriveIncrementalCapability {
  incremental(
    context: PluginContext,
    request: CloudDriveIncrementalRequest
  ): Promise<PluginPage<CloudDriveResourceCandidate>>;
}

export interface CloudDriveAvailabilityCapability {
  availability(
    context: PluginContext,
    request: CloudDriveAvailabilityRequest
  ): Promise<readonly CloudDriveResourceCandidate[]>;
}

/** Optional-method aggregate for hosts that register one cloud-drive adapter. */
export interface CloudDriveCapability
  extends Partial<CloudDriveSearchCapability>,
    Partial<CloudDriveIncrementalCapability>,
    Partial<CloudDriveAvailabilityCapability> {}

export interface PlaybackCapability {
  playback(
    context: PluginContext,
    request: PlaybackRequest
  ): Promise<readonly PlaybackResourceCandidate[]>;
}

export interface DanmuCapability {
  danmu(
    context: PluginContext,
    request: DanmuRequest
  ): Promise<readonly DanmuEvent[]>;
}

export interface ImageCapability {
  image(
    context: PluginContext,
    request: ImageRequest
  ): Promise<readonly ImageCandidate[]>;
}

export interface RecommendationCapability {
  recommendation(
    context: PluginContext,
    request: RecommendationRequest
  ): Promise<readonly RecommendationCandidate[]>;
}

/** A plugin implementation may expose any subset of capabilities. */
export interface PluginCapabilities {
  readonly "content.catalog"?: ContentCatalogCapability;
  readonly "content.calendar"?: ContentCalendarCapability;
  readonly "content.detail"?: ContentDetailCapability;
  readonly "content.search"?: ContentSearchCapability;
  readonly "resource.cloud-drive"?: CloudDriveCapability;
  readonly "resource.playback"?: PlaybackCapability;
  readonly "interaction.danmu"?: DanmuCapability;
  readonly "asset.image"?: ImageCapability;
  readonly recommendation?: RecommendationCapability;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  readonly capabilities: PluginCapabilities;
}
