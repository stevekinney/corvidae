/**
 * The Bureau managed-asset contract (COR-794).
 *
 * `conversationalist`'s portable-content vocabulary (COR-629) already names a
 * managed asset — `ContentSource`'s `{ kind: 'managed-asset'; assetId;
 * revision? }` variant — along with `Modality`, `MimeFamily`, and
 * `MediaLimits`. This module is the owner those names were waiting for: one
 * asset identity, one immutable {@link AssetDescriptor} snapshot, one
 * admission request shape, and the started-work handles every asynchronous
 * asset operation returns. None of the conversationalist names is redefined
 * here; every one is imported and reused.
 *
 * Revisions. `revision` counts persisted changes to one asset's descriptor
 * (admission, retention, holds, expiry, deletion) and only ever increases.
 * An asset's bytes never change under its identity — a transform admits a new
 * asset — so a `managed-asset` reference carrying an older revision still
 * names the same content while the asset is available.
 */
import type { CleanupAcknowledgement, ClosedOptions } from '@lostgradient/operative';
import type { ContentSource, MediaLimits, MimeFamily, Modality } from 'conversationalist';

/** The `managed-asset` member of conversationalist's `ContentSource`. */
export type ManagedAssetSource = Extract<ContentSource, { kind: 'managed-asset' }>;

/**
 * An asset's lifecycle. `pending` is the only non-terminal admission state;
 * `available` is the only state whose bytes resolve. `deleted` is a
 * tombstone: the descriptor survives (so a stale reference is told the asset
 * was deleted rather than that it never existed) until the tombstone's own
 * retention elapses.
 */
export type AssetLifecycleState =
  'pending' | 'available' | 'rejected' | 'quarantined' | 'expired' | 'deleted';

/** Who is asking. `privileged` unlocks the privileged projection and administrative holds — never resource authorization. */
export interface AssetPrincipal {
  readonly id: string;
  readonly privileged?: boolean | undefined;
}

/** Why an admission or later operation refused an asset. Stable codes; messages never carry bytes, secrets, or URLs. */
export type AssetRejectionCode =
  | 'aborted'
  | 'aggregate-limit-exceeded'
  | 'credential-bearing-url'
  | 'dimensions-exceeded'
  | 'dns-rebinding'
  | 'dns-resolution-failed'
  | 'duplicate'
  | 'duration-exceeded'
  | 'fetch-failed'
  | 'held'
  | 'interrupted'
  | 'media-facts-unmeasured'
  | 'media-type-mismatch'
  | 'media-type-not-allowed'
  | 'metadata-extraction-failed'
  | 'page-count-exceeded'
  | 'per-part-limit-exceeded'
  | 'private-address'
  | 'provider-fetch-not-allowed'
  | 'provider-transfer-failed'
  | 'safety-gate-error'
  | 'safety-gate-flagged'
  | 'scheme-not-allowed'
  | 'signed-url-expired'
  | 'source-not-available'
  | 'storage-failure'
  | 'too-many-redirects'
  | 'transform-failed'
  | 'unsupported-source'
  | 'upload-incomplete';

export interface AssetRejection {
  readonly code: AssetRejectionCode;
  readonly message: string;
}

/** Where an asset's bytes came from. URL provenance keeps the origin only — never a path, query, or credential. */
export type AssetProvenance =
  | { readonly kind: 'inline' }
  | { readonly kind: 'upload'; readonly uploadId: string }
  | {
      readonly kind: 'url';
      readonly origin: string;
      readonly fetchedBy: 'host' | 'provider';
      readonly redirects: number;
    }
  | { readonly kind: 'provider-file'; readonly provider: string; readonly providerFileId: string }
  | { readonly kind: 'asset-reference'; readonly sourceAssetId: string }
  | { readonly kind: 'transform'; readonly sourceAssetId: string; readonly transform: string };

/** A holder's renewable claim that keeps an asset from expiring until `until`. */
export interface AssetReference {
  readonly holderId: string;
  readonly until: string;
}

/** A legal or audit hold. While any hold is present the asset can neither expire nor be deleted, and a terminal record is never purged. */
export interface AssetHold {
  readonly holdId: string;
  readonly kind: 'legal' | 'audit';
  readonly placedAt: string;
  readonly placedBy: string;
}

export interface AssetRetention {
  /** The admission-time floor; `undefined` means the asset never expires on its own. */
  readonly retainUntil: string | undefined;
  readonly references: readonly AssetReference[];
  readonly holds: readonly AssetHold[];
}

/** Measured media facts, each present only where the format (or the injected extractor) can report it. */
export interface AssetMediaFacts {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly durationSeconds?: number | undefined;
  readonly pageCount?: number | undefined;
}

/** One safety gate's verdict. A flagged verdict names a category, never the content that triggered it. */
export interface AssetSafetyVerdict {
  readonly gate: string;
  readonly verdict: 'clean' | 'flagged';
  readonly category?: string | undefined;
}

/** A copy of an asset transferred to a model provider's own file store. */
export interface AssetProviderCopy {
  readonly provider: string;
  readonly providerFileId: string;
}

/**
 * Where an asset's bytes live. `bureau` means Bureau holds verified bytes
 * under the asset's digest; `provider-fetch` means a provider-fetch URL
 * declaration (a provider fetches the URL itself, Bureau never does), so
 * there are no Bureau-held bytes, digest, or byte length.
 */
export type AssetCustody = 'bureau' | 'provider-fetch';

/** Fields both projections carry. */
interface AssetDescriptorFields {
  readonly assetId: string;
  readonly revision: number;
  readonly state: AssetLifecycleState;
  readonly custody: AssetCustody;
  /** `sha256:<hex>` over the asset's bytes; absent until verified bytes exist. */
  readonly digest: string | undefined;
  /** The detected media type (or, before detection, the declared one). */
  readonly mediaType: string | undefined;
  readonly modality: Modality | undefined;
  readonly mimeFamily: MimeFamily | undefined;
  readonly byteLength: number | undefined;
  readonly owner: string;
  readonly provenanceKind: AssetProvenance['kind'];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The latest instant any retention floor or reference keeps the asset alive; `undefined` means no expiry. */
  readonly expiresAt: string | undefined;
  readonly source: ManagedAssetSource;
  readonly rejection: AssetRejection | undefined;
}

/**
 * The general projection: what any authorized reader may see. Authorization
 * is reduced to the caller's own access level, and retention to counts.
 */
export interface GeneralAssetDescriptor extends AssetDescriptorFields {
  readonly projection: 'general';
  readonly authorization: { readonly access: 'owner' | 'reader' };
  readonly retention: {
    readonly retainUntil: string | undefined;
    readonly referenceCount: number;
    readonly held: boolean;
  };
}

/**
 * The privileged projection: every persisted fact except bytes, extracted
 * content, and secrets (a provider-fetch URL is never projected — it is only
 * returned by {@link AssetService.resolve} to an authorized caller).
 */
export interface PrivilegedAssetDescriptor extends AssetDescriptorFields {
  readonly projection: 'privileged';
  readonly authorization: { readonly ownerId: string; readonly readers: readonly string[] };
  readonly retention: AssetRetention;
  readonly provenance: AssetProvenance;
  readonly declaredMediaType: string | undefined;
  readonly media: AssetMediaFacts;
  readonly safety: readonly AssetSafetyVerdict[];
  readonly providerCopies: readonly AssetProviderCopy[];
  readonly expiredAt: string | undefined;
  readonly deletedAt: string | undefined;
  readonly tombstoneUntil: string | undefined;
}

/** An immutable (frozen) snapshot of one asset at one revision. */
export type AssetDescriptor = GeneralAssetDescriptor | PrivilegedAssetDescriptor;

export type AssetProjection = AssetDescriptor['projection'];

// ── Admission ─────────────────────────────────────────────────────────

/** The five admission sources the contract accepts. */
export type AssetAdmissionSource =
  | { readonly kind: 'inline'; readonly bytes: Uint8Array }
  | { readonly kind: 'upload'; readonly uploadId: string }
  | { readonly kind: 'url'; readonly url: string; readonly fetchedBy: 'host' | 'provider' }
  | { readonly kind: 'provider-file'; readonly provider: string; readonly providerFileId: string }
  | { readonly kind: 'managed-asset'; readonly assetId: string; readonly revision?: number };

export interface AssetAdmissionRequest {
  readonly source: AssetAdmissionSource;
  /** The caller's claim; admission compares it against the detected media type. */
  readonly declaredMediaType?: string | undefined;
  /** Additional principals allowed to read the asset. The admitting principal always owns it. */
  readonly readers?: readonly string[] | undefined;
  /** Overrides the policy's default retention for this asset. */
  readonly retainForMilliseconds?: number | undefined;
}

/**
 * `admit()`'s immediate answer: the asset's durable identity (already
 * persisted as `pending`) and the started-work handle that carries the rest
 * of the admission. `admit()` never waits for fetch, scan, or extraction.
 */
export interface AssetAdmission {
  readonly assetId: string;
  readonly source: ManagedAssetSource;
  /** The pending descriptor, in the projection the admitting principal may see. */
  readonly descriptor: AssetDescriptor;
  readonly work: AssetWorkHandle<AssetDescriptor>;
}

export interface AssetUploadSession {
  readonly uploadId: string;
  readonly declaredMediaType: string | undefined;
  readonly declaredByteLength: number;
  readonly receivedBytes: number;
  readonly state: 'open';
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** What a successful {@link AssetService.resolve} hands back. */
export interface ResolvedAsset {
  readonly descriptor: GeneralAssetDescriptor;
  readonly content:
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
    | { readonly kind: 'provider-fetch'; readonly url: string };
}

// ── Policy ────────────────────────────────────────────────────────────

export type AssetDuplicatePolicy = 'reuse' | 'reject' | 'store-separately';

export interface AssetUrlPolicy {
  /** Lower-case schemes with the trailing colon, e.g. `'https:'`. */
  readonly allowedSchemes: readonly string[];
  readonly allowPrivateNetwork: boolean;
  readonly maxRedirects: number;
  /** Whether a provider-fetch declaration may be admitted at all. */
  readonly allowProviderFetch: boolean;
}

export interface AssetPolicy {
  /** Per-part and aggregate limits, reusing conversationalist's `MediaLimits` verbatim. */
  readonly limits: readonly MediaLimits[];
  /** The hard ceiling on inline bytes, checked before `admit()` persists anything. */
  readonly maxInlineBytes: number;
  /**
   * The hard ceiling on one asset's bytes from any source: an upload's
   * declared length is refused above it before any chunk is stored, and a
   * fetch, provider download, or transform is handed it as `maxBytes` and
   * refused above it before anything else is done with the bytes.
   */
  readonly maxAssetBytes: number;
  /** `undefined` allows every detected type. */
  readonly allowedMediaTypes: readonly string[] | undefined;
  readonly duplicatePolicy: AssetDuplicatePolicy;
  readonly url: AssetUrlPolicy;
  readonly defaultRetentionMilliseconds: number | undefined;
  readonly tombstoneRetentionMilliseconds: number;
  readonly uploadSessionTtlMilliseconds: number;
}

export interface AssetPolicyInput extends Partial<Omit<AssetPolicy, 'url'>> {
  readonly url?: Partial<AssetUrlPolicy> | undefined;
}

// ── Injected ports ────────────────────────────────────────────────────

/** Resolves a host name to its addresses. The only DNS access the asset service has. */
export type AssetHostResolver = (hostname: string) => Promise<readonly string[]>;

export interface AssetFetchRequest {
  readonly url: string;
  /** The validated address the connection must be pinned to. */
  readonly address: string;
  /** The most body bytes the service will accept; a port should stop reading past it. */
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface AssetFetchResponse {
  readonly status: number;
  readonly location?: string | undefined;
  readonly contentType?: string | undefined;
  readonly body: Uint8Array;
}

/** Performs one HTTP exchange without following redirects — the service follows and revalidates each hop itself. */
export type AssetFetcher = (request: AssetFetchRequest) => Promise<AssetFetchResponse>;

export interface AssetProviderTransport {
  download(request: {
    readonly providerFileId: string;
    /** The most bytes the service will accept; a transport should stop reading past it. */
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly bytes: Uint8Array; readonly mediaType?: string | undefined }>;
  upload(request: {
    readonly bytes: Uint8Array;
    readonly mediaType: string | undefined;
    readonly signal: AbortSignal;
  }): Promise<{ readonly providerFileId: string }>;
  delete?(request: {
    readonly providerFileId: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

/**
 * Extracts measured facts the built-in inspection cannot (audio/video
 * duration, say). `extractedText` is protected extracted content: the
 * service drops it at this boundary and never persists, projects, emits, or
 * audits it.
 */
export type AssetMetadataExtractor = (request: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly signal: AbortSignal;
}) => Promise<AssetMediaFacts & { readonly extractedText?: string | undefined }>;

export interface AssetSafetyGate {
  readonly name: string;
  inspect(request: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly digest: string;
    readonly signal: AbortSignal;
  }): Promise<
    { readonly verdict: 'clean' } | { readonly verdict: 'flagged'; readonly category: string }
  >;
}

export type AssetTransformer = (request: {
  readonly bytes: Uint8Array;
  readonly mediaType: string | undefined;
  readonly signal: AbortSignal;
}) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;

export interface AssetPorts {
  readonly resolveHost?: AssetHostResolver | undefined;
  readonly fetch?: AssetFetcher | undefined;
  readonly providers?: Readonly<Record<string, AssetProviderTransport>> | undefined;
  readonly extractMetadata?: AssetMetadataExtractor | undefined;
  readonly safetyGates?: readonly AssetSafetyGate[] | undefined;
  readonly transformers?: Readonly<Record<string, AssetTransformer>> | undefined;
}

// ── Started work ──────────────────────────────────────────────────────

/** Every asynchronous asset operation, each exposed as its own started-work handle. */
export type AssetWorkKind =
  | 'admission'
  | 'upload'
  | 'fetch'
  | 'scan'
  | 'transform'
  | 'metadata-extraction'
  | 'provider-transfer'
  | 'deletion'
  | 'garbage-collection';

export type AssetWorkResult<T> =
  | { readonly outcome: 'completed'; readonly value: T }
  | { readonly outcome: 'failed'; readonly rejection: AssetRejection }
  | { readonly outcome: 'aborted'; readonly reason: string };

/**
 * Structurally satisfies the started-work snapshot floor
 * (`documentation/operative-type-safe-api.md` § "The common facts"), the same
 * way `CatalogRefreshSnapshot` does.
 */
export interface AssetWorkSnapshot<T = unknown> {
  readonly id: string;
  readonly kind: `asset-${AssetWorkKind}`;
  readonly workKind: AssetWorkKind;
  readonly assetId: string | undefined;
  readonly parentId: string | undefined;
  readonly owner: string | undefined;
  readonly startedAt: string;
  readonly revision: number;
  readonly status: 'pending' | 'settled';
  readonly lastTransitionAt: string;
  readonly projection: 'privileged';
  readonly ownership: 'independent' | 'parent-owned';
  readonly detached: false;
  readonly durability: 'process-local';
  readonly cancellable: boolean;
  readonly result?: AssetWorkResult<T> | undefined;
}

export interface AssetWorkHandle<T = unknown> {
  readonly workId: string;
  /** Cached, immutable, side-effect-free. */
  snapshot(): AssetWorkSnapshot<T>;
  /** Delivers the current snapshot synchronously, then every later revision. Returns an unsubscribe function. */
  subscribeSnapshot(
    observer: (snapshot: AssetWorkSnapshot<T>) => void,
    options?: { readonly signal?: AbortSignal | undefined },
  ): () => void;
  /** Idempotent and never throws; a no-op once settled. */
  abort(reason?: string): void;
  /** Never rejects. */
  result(): Promise<AssetWorkResult<T>>;
  /** Never rejects; memoized once cleanup genuinely settles. */
  closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>;
}

// ── Events and audit ──────────────────────────────────────────────────

export type AssetEventType =
  | 'asset.admission.started'
  | 'asset.available'
  | 'asset.rejected'
  | 'asset.quarantined'
  | 'asset.retained'
  | 'asset.released'
  | 'asset.hold.placed'
  | 'asset.hold.released'
  | 'asset.expired'
  | 'asset.deleted'
  | 'asset.purged'
  | 'asset.provider-copy.created'
  | 'asset.provider-copy.deleted'
  | 'asset.upload.started'
  | 'asset.upload.aborted'
  | 'asset.upload.purged'
  | 'asset.blob.purged'
  | 'asset.work.started'
  | 'asset.work.settled';

/**
 * One asset event. Every field is a scalar fact — identifiers, states,
 * codes, counts, and digests. Raw bytes, extracted content, URLs beyond their
 * origin, and credentials have no field to travel in.
 */
export interface AssetEvent {
  readonly type: AssetEventType;
  readonly at: string;
  readonly sequence: number;
  readonly assetId?: string | undefined;
  readonly revision?: number | undefined;
  readonly state?: AssetLifecycleState | undefined;
  readonly principal?: string | undefined;
  readonly workId?: string | undefined;
  readonly workKind?: AssetWorkKind | undefined;
  readonly outcome?: AssetWorkResult<unknown>['outcome'] | undefined;
  readonly code?: AssetRejectionCode | undefined;
  readonly digest?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly byteLength?: number | undefined;
  readonly origin?: string | undefined;
  readonly holderId?: string | undefined;
  readonly holdId?: string | undefined;
  readonly uploadId?: string | undefined;
  readonly provider?: string | undefined;
  readonly gate?: string | undefined;
  readonly category?: string | undefined;
}

/** A durable audit record: the persisted form of an {@link AssetEvent}. */
export type AssetAuditRecord = AssetEvent;

export interface AssetGarbageCollectionReport {
  readonly expired: readonly string[];
  readonly purgedTombstones: readonly string[];
  readonly purgedBlobs: readonly string[];
  readonly purgedUploads: readonly string[];
  readonly interruptedAdmissions: readonly string[];
  /** Blobs left in place because a resolution was still reading them. */
  readonly leasedBlobs: readonly string[];
}

export interface AssetShutdownReport {
  readonly aborted: readonly string[];
  readonly acknowledgements: readonly {
    readonly workId: string;
    readonly acknowledgement: CleanupAcknowledgement;
  }[];
}

/** The asset service — see `asset-service.ts` for the contract of each operation. */
export interface AssetService {
  readonly durability: 'process-local' | 'durable';
  readonly policy: AssetPolicy;
  admit(request: AssetAdmissionRequest, principal: AssetPrincipal): Promise<AssetAdmission>;
  admitAll(
    requests: readonly AssetAdmissionRequest[],
    principal: AssetPrincipal,
  ): Promise<readonly AssetAdmission[]>;
  beginUpload(
    principal: AssetPrincipal,
    request: {
      readonly declaredMediaType?: string | undefined;
      readonly declaredByteLength: number;
    },
  ): Promise<AssetUploadSession>;
  /**
   * Adds one chunk to the open session. Each append is one compare-and-swap on the session, so
   * an append that loses to another (in this process or any process sharing the storage) rejects
   * with `AssetConflictError` and stores nothing. A session that already holds a chunk at its next
   * index (a dead writer's residue) answers `AssetConflictError` until it expires.
   */
  appendUpload(
    uploadId: string,
    principal: AssetPrincipal,
    bytes: Uint8Array,
  ): Promise<AssetUploadSession>;
  /**
   * Discards the open session and its chunks in one compare-and-swap. An abort that loses to an
   * append, a claim or a completion (in this process or any process sharing the storage) rejects
   * with `AssetConflictError` and deletes nothing, so it cannot remove a terminal record.
   */
  abortUpload(uploadId: string, principal: AssetPrincipal): Promise<void>;
  /**
   * The open upload session `uploadId`, as its owner sees it. A session that does not exist, is
   * not open (completed, aborted or expired), or belongs to another principal is not found: the
   * management plane asks before it admits, so a refused completion starts no admission.
   */
  inspectUpload(uploadId: string, principal: AssetPrincipal): Promise<AssetUploadSession>;
  /**
   * The asset a completed upload session admitted (or reused, under the `reuse` duplicate policy),
   * for a caller retrying a completion whose answer it lost; the session keeps it until its
   * `expiresAt`. `undefined` while the session is still open. A session whose completion is in
   * flight rejects with `AssetConflictError`, and one that does not exist, has expired, or belongs
   * to another principal with `AssetNotFoundError`.
   */
  completedUploadAssetId(uploadId: string, principal: AssetPrincipal): Promise<string | undefined>;
  inspect(
    assetId: string,
    principal: AssetPrincipal,
    options?: { readonly projection?: AssetProjection | undefined },
  ): Promise<AssetDescriptor>;
  resolve(
    reference: ManagedAssetSource | { readonly assetId: string; readonly revision?: number },
    principal: AssetPrincipal,
  ): Promise<ResolvedAsset>;
  retain(
    assetId: string,
    principal: AssetPrincipal,
    reference: { readonly holderId: string; readonly until: string },
  ): Promise<AssetDescriptor>;
  release(assetId: string, principal: AssetPrincipal, holderId: string): Promise<AssetDescriptor>;
  placeHold(
    assetId: string,
    principal: AssetPrincipal,
    hold: { readonly holdId: string; readonly kind: 'legal' | 'audit' },
  ): Promise<AssetDescriptor>;
  releaseHold(assetId: string, principal: AssetPrincipal, holdId: string): Promise<AssetDescriptor>;
  expire(assetId: string, principal: AssetPrincipal): Promise<AssetDescriptor>;
  delete(assetId: string, principal: AssetPrincipal): AssetWorkHandle<AssetDescriptor>;
  transform(
    assetId: string,
    principal: AssetPrincipal,
    request: { readonly transform: string },
  ): Promise<AssetAdmission>;
  transferToProvider(
    assetId: string,
    principal: AssetPrincipal,
    request: { readonly provider: string },
  ): AssetWorkHandle<AssetProviderCopy>;
  collectGarbage(): AssetWorkHandle<AssetGarbageCollectionReport>;
  work(workId: string): AssetWorkHandle | undefined;
  abort(workId: string, reason?: string): boolean;
  activeWork(): readonly AssetWorkSnapshot[];
  /** Timer handles the service itself has armed and not yet cleared. */
  activeTimers(): readonly string[];
  subscribe(listener: (event: AssetEvent) => void): () => void;
  auditRecords(): Promise<readonly AssetAuditRecord[]>;
  shutdown(): Promise<AssetShutdownReport>;
}
