/**
 * The admission pipeline (COR-794).
 *
 * `beginAdmission` refuses what can be refused synchronously (an inline
 * payload over the ceiling, a source the caller cannot read), persists the
 * asset as `pending`, and returns its identity with a started-work handle —
 * never waiting for fetch, extraction, or scanning. The handle's body then:
 *
 * 1. acquires bytes — inline, an upload completion (`upload` work), a host
 *    fetch (`fetch` work), a provider download (`provider-transfer` work),
 *    an existing asset's blob, or a transform of one (`transform` work); a
 *    provider-fetch declaration acquires nothing and is committed as such;
 * 2. digests them (SHA-256);
 * 3. reconciles the declared media type with the detected one, checks the
 *    allowlist, measures dimensions and page counts, and runs the injected
 *    extractor (`metadata-extraction` work) for anything else;
 * 4. enforces per-part and aggregate `MediaLimits`;
 * 5. runs every safety gate (`scan` work) — a flagged asset is quarantined,
 *    a failing gate rejects it (fail closed);
 * 6. applies the duplicate policy; and
 * 7. commits: the blob (once per digest), then one compare-and-swap that
 *    flips the record to `available` together with its owner and digest keys.
 *
 * Any failure flips the record to `rejected` with a stable code. If even that
 * write fails, the record stays `pending` and garbage collection recovers it
 * as `interrupted` once no live admission owns it.
 */
import { sha256BytesHex } from '@lostgradient/cryptography';
import type { MediaLimits, Modality } from 'conversationalist';

import { decodeBase64, encodeBase64 } from './base64';
import { AssetAdmissionError, AssetIntegrityError, AssetUnavailableError } from './errors';
import { type AssetInternals, classifyFailure } from './internals';
import {
  detectMediaType,
  inspectMediaFacts,
  modalityOf,
  normalizeMediaType,
  reconcileMediaType,
} from './media-inspection';
import type { AssetWorkContext } from './operation';
import {
  type AssetRecord,
  authorize,
  createRecord,
  KEYS,
  loadRecord,
  managedAssetSourceOf,
  projectFor,
  replaceRecord,
} from './records';
import type {
  AssetAdmission,
  AssetAdmissionRequest,
  AssetAdmissionSource,
  AssetDescriptor,
  AssetMediaFacts,
  AssetPrincipal,
  AssetProvenance,
  AssetRejection,
  AssetSafetyVerdict,
} from './types';
import { checkUrl, fetchWithPolicy, originOf } from './url-policy';

/** The public sources plus the one a transform admits through. */
export type InternalAdmissionSource =
  | AssetAdmissionSource
  | { readonly kind: 'derived'; readonly sourceAssetId: string; readonly transform: string };

export interface AdmissionPlan {
  readonly assetId: string;
  readonly principal: AssetPrincipal;
  readonly source: InternalAdmissionSource;
  readonly declaredMediaType: string | undefined;
  readonly budget: AggregateBudget | undefined;
  readonly slot: number;
}

// ── Aggregate limits ──────────────────────────────────────────────────

interface Usage {
  bytes: number;
  durationSeconds: number;
  pageCount: number;
}

/**
 * Aggregate `MediaLimits` across the parts of one `admitAll` call. Parts
 * decide in request order — part N waits for part N-1's decision — so which
 * part overflows the budget is deterministic regardless of which part's
 * bytes arrive first.
 */
export interface AggregateBudget {
  /**
   * Waits for the previous slot's decision, then reserves `usage`. An abort
   * of `signal` while waiting rejects at once with the abort reason and
   * reserves nothing; the caller's `skip(slot)` keeps the ordering chain.
   */
  reserve(slot: number, modality: Modality, usage: Usage, signal: AbortSignal): Promise<boolean>;
  /** Marks a slot decided without reserving (it failed before reaching the budget). */
  skip(slot: number): void;
}

/** Resolves when `decided` does; rejects with the abort reason the moment `signal` aborts first. */
function untilDecidedOrAborted(decided: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void decided.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

export function createAggregateBudget(
  limits: readonly MediaLimits[],
  parts: number,
): AggregateBudget {
  const aggregate = limits.filter((limit) => limit.scope === 'aggregate');
  const used = new Map<Modality, Usage>();
  const decided = Array.from({ length: parts }, () => Promise.withResolvers<void>());
  const done = new Set<number>();
  const finish = (slot: number) => {
    if (done.has(slot)) return;
    done.add(slot);
    decided[slot]?.resolve();
  };
  return {
    async reserve(slot, modality, usage, signal) {
      const previous = slot > 0 ? decided[slot - 1]?.promise : undefined;
      if (previous) await untilDecidedOrAborted(previous, signal);
      try {
        const current = used.get(modality) ?? { bytes: 0, durationSeconds: 0, pageCount: 0 };
        const next = {
          bytes: current.bytes + usage.bytes,
          durationSeconds: current.durationSeconds + usage.durationSeconds,
          pageCount: current.pageCount + usage.pageCount,
        };
        const exceeded = aggregate.some(
          (limit) =>
            limit.modality === modality &&
            ((limit.maxBytes !== undefined && next.bytes > limit.maxBytes) ||
              (limit.maxDurationSeconds !== undefined &&
                next.durationSeconds > limit.maxDurationSeconds) ||
              (limit.maxPageCount !== undefined && next.pageCount > limit.maxPageCount)),
        );
        if (!exceeded) used.set(modality, next);
        return !exceeded;
      } finally {
        finish(slot);
      }
    },
    skip(slot) {
      // A later part must not wait on an earlier part that never reaches the budget.
      if (slot === 0 || done.has(slot - 1)) finish(slot);
      else void decided[slot - 1]?.promise.then(() => finish(slot));
    },
  };
}

function unmeasured(fact: string, limit: string): AssetAdmissionError {
  return new AssetAdmissionError(
    'media-facts-unmeasured',
    `The ${fact} could not be measured, so ${limit} cannot be enforced.`,
  );
}

/**
 * Fails closed: a limit that names a fact (pixels, duration, pages) for this
 * modality refuses a part whose fact neither the built-in inspection nor the
 * injected extractor measured. Aggregate limits need duration and page
 * counts to sum; pixels are per-part only.
 */
function requireMeasuredFacts(
  limits: readonly MediaLimits[],
  modality: Modality,
  facts: AssetMediaFacts,
): void {
  for (const limit of limits) {
    if (limit.modality !== modality) continue;
    if (
      limit.scope === 'per-part' &&
      limit.maxPixels !== undefined &&
      (facts.width === undefined || facts.height === undefined)
    ) {
      throw unmeasured('image dimensions', 'maxPixels');
    }
    if (limit.maxDurationSeconds !== undefined && facts.durationSeconds === undefined) {
      throw unmeasured('media duration', 'maxDurationSeconds');
    }
    if (limit.maxPageCount !== undefined && facts.pageCount === undefined) {
      throw unmeasured('page count', 'maxPageCount');
    }
  }
}

function checkPerPartLimits(
  limits: readonly MediaLimits[],
  modality: Modality,
  byteLength: number,
  facts: AssetMediaFacts,
): void {
  requireMeasuredFacts(limits, modality, facts);
  for (const limit of limits) {
    if (limit.scope !== 'per-part' || limit.modality !== modality) continue;
    if (limit.maxBytes !== undefined && byteLength > limit.maxBytes) {
      throw new AssetAdmissionError(
        'per-part-limit-exceeded',
        `The part exceeds ${limit.maxBytes} bytes.`,
      );
    }
    const pixels = (facts.width ?? 0) * (facts.height ?? 0);
    if (limit.maxPixels !== undefined && pixels > limit.maxPixels) {
      throw new AssetAdmissionError(
        'dimensions-exceeded',
        `The image exceeds ${limit.maxPixels} pixels.`,
      );
    }
    if (
      limit.maxDurationSeconds !== undefined &&
      (facts.durationSeconds ?? 0) > limit.maxDurationSeconds
    ) {
      throw new AssetAdmissionError(
        'duration-exceeded',
        `The media exceeds ${limit.maxDurationSeconds} seconds.`,
      );
    }
    if (limit.maxPageCount !== undefined && (facts.pageCount ?? 0) > limit.maxPageCount) {
      throw new AssetAdmissionError(
        'page-count-exceeded',
        `The document exceeds ${limit.maxPageCount} pages.`,
      );
    }
  }
}

// ── Starting an admission ─────────────────────────────────────────────

function provenanceOf(source: InternalAdmissionSource): AssetProvenance {
  switch (source.kind) {
    case 'inline':
      return { kind: 'inline' };
    case 'upload':
      return { kind: 'upload', uploadId: source.uploadId };
    case 'url':
      return {
        kind: 'url',
        origin: originOf(source.url),
        fetchedBy: source.fetchedBy,
        redirects: 0,
      };
    case 'provider-file':
      return {
        kind: 'provider-file',
        provider: source.provider,
        providerFileId: source.providerFileId,
      };
    case 'managed-asset':
      return { kind: 'asset-reference', sourceAssetId: source.assetId };
    case 'derived':
      return {
        kind: 'transform',
        sourceAssetId: source.sourceAssetId,
        transform: source.transform,
      };
  }
}

/** Refusals that need no persisted identity: an oversize inline payload, or a source the caller cannot read. */
export async function preflightAdmission(
  internals: AssetInternals,
  principal: AssetPrincipal,
  source: InternalAdmissionSource,
): Promise<void> {
  if (source.kind === 'inline' && source.bytes.byteLength > internals.policy.maxInlineBytes) {
    throw new AssetAdmissionError(
      'per-part-limit-exceeded',
      `Inline bytes exceed the ${internals.policy.maxInlineBytes}-byte inline ceiling.`,
    );
  }
  if (source.kind === 'managed-asset' || source.kind === 'derived') {
    const sourceId = source.kind === 'derived' ? source.sourceAssetId : source.assetId;
    const loaded = await loadRecord(internals.storage, sourceId);
    const record = authorize(loaded?.record, sourceId, principal);
    if (
      source.kind === 'managed-asset' &&
      source.revision !== undefined &&
      source.revision > record.revision
    ) {
      throw new AssetAdmissionError(
        'source-not-available',
        'The referenced revision does not exist.',
      );
    }
    if (record.state !== 'available' || record.custody !== 'bureau') {
      throw new AssetUnavailableError(sourceId, record.state);
    }
  }
}

export async function beginAdmission(
  internals: AssetInternals,
  principal: AssetPrincipal,
  request: Omit<AssetAdmissionRequest, 'source'> & { readonly source: InternalAdmissionSource },
  budget: AggregateBudget | undefined,
  slot: number,
  options: { readonly preflighted?: boolean } = {},
): Promise<AssetAdmission> {
  if (!options.preflighted) await preflightAdmission(internals, principal, request.source);
  const assetId = internals.runtime.identifiers.next('asset');
  const now = internals.nowIso();
  const retainFor = request.retainForMilliseconds ?? internals.policy.defaultRetentionMilliseconds;
  const record: AssetRecord = {
    version: 1,
    assetId,
    revision: 1,
    state: 'pending',
    custody:
      request.source.kind === 'url' && request.source.fetchedBy === 'provider'
        ? 'provider-fetch'
        : 'bureau',
    ownerId: principal.id,
    readers: [...new Set(request.readers ?? [])].filter((reader) => reader !== principal.id),
    declaredMediaType:
      request.declaredMediaType === undefined
        ? undefined
        : normalizeMediaType(request.declaredMediaType),
    media: {},
    provenance: provenanceOf(request.source),
    createdAt: now,
    updatedAt: now,
    retainUntil: retainFor === undefined ? undefined : internals.isoAfter(retainFor),
    references: [],
    holds: [],
    safety: [],
    providerCopies: [],
  };
  internals.pendingAdmissions.add(assetId);
  try {
    await createRecord(internals.storage, record);
  } catch (error) {
    internals.pendingAdmissions.delete(assetId);
    budget?.skip(slot);
    throw error;
  }
  await internals.emit({
    type: 'asset.admission.started',
    assetId,
    revision: 1,
    state: 'pending',
    principal: principal.id,
  });

  const plan: AdmissionPlan = {
    assetId,
    principal,
    source: request.source,
    declaredMediaType: record.declaredMediaType,
    budget,
    slot,
  };
  const work = internals.registry.start<AssetDescriptor>(
    {
      kind: 'admission',
      assetId,
      owner: principal.id,
      classify: (error) => classifyFailure(error),
    },
    (context) => runAdmission(internals, plan, context),
  );
  void work.closed().then(() => internals.pendingAdmissions.delete(assetId));
  return {
    assetId,
    source: managedAssetSourceOf(record),
    descriptor: projectFor(record, principal),
    work,
  };
}

// ── The pipeline ──────────────────────────────────────────────────────

interface AcquiredBytes {
  readonly kind: 'bytes';
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly provenance: AssetProvenance;
}

/** Reads a stored asset's bytes under a lease, verifying them against the recorded digest. */
export async function readVerifiedBytes(
  internals: AssetInternals,
  record: AssetRecord,
  track: <T>(promise: Promise<T>) => Promise<T> = (promise) => promise,
): Promise<Uint8Array> {
  const digest = record.digest;
  if (digest === undefined) throw new AssetIntegrityError(record.assetId);
  const release = internals.leases.acquire(digest);
  try {
    const raw = await track(internals.storage.get(KEYS.blob(digest)));
    if (raw === null) throw new AssetIntegrityError(record.assetId);
    const bytes = decodeBase64(raw);
    if (`sha256:${await sha256BytesHex(bytes)}` !== digest)
      throw new AssetIntegrityError(record.assetId);
    return bytes;
  } finally {
    release();
  }
}

async function readSourceAsset(
  internals: AssetInternals,
  context: AssetWorkContext,
  assetId: string,
): Promise<AssetRecord & { bytes: Uint8Array }> {
  const loaded = await context.track(loadRecord(internals.storage, assetId));
  if (!loaded || loaded.record.state !== 'available' || loaded.record.custody !== 'bureau') {
    throw new AssetAdmissionError('source-not-available', 'The source asset is not available.');
  }
  return {
    ...loaded.record,
    bytes: await readVerifiedBytes(internals, loaded.record, context.track),
  };
}

interface UploadSessionRecord {
  readonly uploadId: string;
  readonly ownerId: string;
  readonly declaredMediaType?: string | undefined;
  readonly declaredByteLength: number;
  readonly receivedBytes: number;
  readonly chunkCount: number;
  /** Only open sessions are ever stored: completion and abort delete the session with its chunks. */
  readonly state: 'open';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type { UploadSessionRecord };

/**
 * Completes an upload under the session's lock — the one `appendUpload`,
 * `abortUpload`, and upload collection take — so no chunk can be appended
 * between reading the chunks and retiring the session.
 */
function assembleUpload(
  internals: AssetInternals,
  context: AssetWorkContext,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<AcquiredBytes> {
  return internals.withLock(`upload:${uploadId}`, () =>
    assembleLockedUpload(internals, context, uploadId, principal),
  );
}

async function assembleLockedUpload(
  internals: AssetInternals,
  context: AssetWorkContext,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<AcquiredBytes> {
  const { storage } = internals;
  const raw = await context.track(storage.get(KEYS.upload(uploadId)));
  const session = raw === null ? undefined : (JSON.parse(raw) as UploadSessionRecord);
  if (
    !session ||
    session.ownerId !== principal.id ||
    session.state !== 'open' ||
    Date.parse(session.expiresAt) <= internals.now()
  ) {
    throw new AssetAdmissionError('source-not-available', 'The upload session is not open.');
  }
  const keys = await context.track(storage.list(KEYS.chunkPrefix(uploadId)));
  const chunks: Uint8Array[] = [];
  for (const key of keys) {
    const chunk = await context.track(storage.get(key));
    if (chunk !== null) chunks.push(decodeBase64(chunk));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total !== session.declaredByteLength) {
    throw new AssetAdmissionError(
      'upload-incomplete',
      `The upload holds ${total} of ${session.declaredByteLength} bytes.`,
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Completion retires the session: its chunks are now the asset's bytes.
  for (const key of keys) await context.track(storage.delete(key));
  await context.track(storage.delete(KEYS.upload(uploadId)));
  return {
    kind: 'bytes',
    bytes,
    contentType: session.declaredMediaType,
    provenance: { kind: 'upload', uploadId },
  };
}

async function acquire(
  internals: AssetInternals,
  plan: AdmissionPlan,
  context: AssetWorkContext,
): Promise<AcquiredBytes | { readonly kind: 'provider-fetch'; readonly url: string }> {
  const { source } = plan;
  const { policy, ports } = internals;
  switch (source.kind) {
    case 'inline':
      return {
        kind: 'bytes',
        bytes: source.bytes.slice(),
        contentType: undefined,
        provenance: { kind: 'inline' },
      };
    case 'upload':
      return context.child(
        'upload',
        (child) => assembleUpload(internals, child, source.uploadId, plan.principal),
        (error) => classifyFailure(error),
      );
    case 'url': {
      if (source.fetchedBy === 'provider') {
        if (!policy.url.allowProviderFetch) {
          throw new AssetAdmissionError(
            'provider-fetch-not-allowed',
            'Provider-fetch declarations are not allowed.',
          );
        }
        checkUrl(source.url, policy.url, internals.now());
        return { kind: 'provider-fetch', url: source.url };
      }
      const fetched = await context.child(
        'fetch',
        (child) =>
          fetchWithPolicy({
            url: source.url,
            policy: policy.url,
            now: internals.now,
            resolveHost: ports.resolveHost,
            fetch: ports.fetch,
            maxBytes: policy.maxAssetBytes,
            signal: child.signal,
            track: child.track,
          }),
        (error) => classifyFailure(error, 'fetch-failed'),
      );
      return {
        kind: 'bytes',
        bytes: fetched.bytes,
        contentType: fetched.contentType,
        provenance: {
          kind: 'url',
          origin: fetched.origin,
          fetchedBy: 'host',
          redirects: fetched.redirects,
        },
      };
    }
    case 'provider-file':
      return context.child(
        'provider-transfer',
        async (child) => {
          const transport = ports.providers?.[source.provider];
          if (!transport)
            throw new AssetAdmissionError('unsupported-source', 'The provider is not configured.');
          const downloaded = await child.track(
            transport.download({
              providerFileId: source.providerFileId,
              maxBytes: policy.maxAssetBytes,
              signal: child.signal,
            }),
          );
          return {
            kind: 'bytes' as const,
            bytes: downloaded.bytes,
            contentType: downloaded.mediaType,
            provenance: provenanceOf(source),
          };
        },
        (error) => classifyFailure(error, 'provider-transfer-failed'),
      );
    case 'managed-asset': {
      const original = await readSourceAsset(internals, context, source.assetId);
      return {
        kind: 'bytes',
        bytes: original.bytes,
        contentType: original.mediaType,
        provenance: provenanceOf(source),
      };
    }
    case 'derived':
      return context.child(
        'transform',
        async (child) => {
          const transformer = ports.transformers?.[source.transform];
          if (!transformer)
            throw new AssetAdmissionError('unsupported-source', 'The transform is not configured.');
          const original = await readSourceAsset(internals, child, source.sourceAssetId);
          const transformed = await child.track(
            transformer({
              bytes: original.bytes,
              mediaType: original.mediaType,
              signal: child.signal,
            }),
          );
          return {
            kind: 'bytes' as const,
            bytes: transformed.bytes,
            contentType: transformed.mediaType,
            provenance: provenanceOf(source),
          };
        },
        (error) => classifyFailure(error, 'transform-failed'),
      );
  }
}

/** Flips a still-pending record to `rejected`. Best-effort: a failed write leaves it for garbage collection to recover. */
export async function settleRejected(
  internals: AssetInternals,
  assetId: string,
  rejection: AssetRejection,
  extra: Partial<AssetRecord> = {},
): Promise<AssetRecord | undefined> {
  try {
    return await internals.withLock(assetId, async () => {
      const loaded = await loadRecord(internals.storage, assetId);
      if (!loaded || loaded.record.state !== 'pending') return undefined;
      const now = internals.nowIso();
      const next: AssetRecord = {
        ...loaded.record,
        ...extra,
        revision: loaded.record.revision + 1,
        state: 'rejected',
        rejection: { code: rejection.code, message: rejection.message },
        updatedAt: now,
        tombstoneUntil: internals.isoAfter(internals.policy.tombstoneRetentionMilliseconds),
      };
      await replaceRecord(internals.storage, loaded, next);
      await internals.emit({
        type: 'asset.rejected',
        assetId,
        revision: next.revision,
        state: 'rejected',
        code: rejection.code,
      });
      return next;
    });
  } catch {
    return undefined;
  }
}

interface Inspected {
  readonly mediaType: string;
  readonly facts: AssetMediaFacts;
}

async function inspect(
  internals: AssetInternals,
  context: AssetWorkContext,
  bytes: Uint8Array,
  declared: string | undefined,
): Promise<Inspected> {
  const mediaType = reconcileMediaType(declared, detectMediaType(bytes));
  if (mediaType === undefined) {
    throw new AssetAdmissionError(
      'media-type-mismatch',
      'The declared media type does not match the content.',
    );
  }
  const allowed = internals.policy.allowedMediaTypes;
  if (allowed !== undefined && !allowed.map(normalizeMediaType).includes(mediaType)) {
    throw new AssetAdmissionError(
      'media-type-not-allowed',
      `The media type "${mediaType}" is not allowed.`,
    );
  }
  let facts = inspectMediaFacts(bytes, mediaType);
  const extract = internals.ports.extractMetadata;
  if (extract) {
    const extracted = await context.child(
      'metadata-extraction',
      (child) => child.track(extract({ bytes, mediaType, signal: child.signal })),
      (error) => classifyFailure(error, 'metadata-extraction-failed'),
    );
    // Only measured numbers survive; `extractedText` is dropped here, at the boundary.
    const measured: AssetMediaFacts = {};
    for (const key of ['width', 'height', 'durationSeconds', 'pageCount'] as const) {
      const value = extracted[key];
      if (typeof value === 'number' && Number.isFinite(value))
        Object.assign(measured, { [key]: value });
    }
    facts = { ...facts, ...measured };
  }
  return { mediaType, facts };
}

async function scan(
  internals: AssetInternals,
  context: AssetWorkContext,
  bytes: Uint8Array,
  mediaType: string,
  digest: string,
): Promise<AssetSafetyVerdict[]> {
  const gates = internals.ports.safetyGates ?? [];
  if (gates.length === 0) return [];
  return context.child(
    'scan',
    async (child) => {
      const verdicts: AssetSafetyVerdict[] = [];
      for (const gate of gates) {
        const verdict = await child.track(
          gate.inspect({ bytes, mediaType, digest, signal: child.signal }),
        );
        verdicts.push(
          verdict.verdict === 'flagged'
            ? { gate: gate.name, verdict: 'flagged', category: verdict.category }
            : { gate: gate.name, verdict: 'clean' },
        );
      }
      return verdicts;
    },
    (error) => classifyFailure(error, 'safety-gate-error'),
  );
}

interface Measured {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly mediaType: string;
  readonly facts: AssetMediaFacts;
  readonly provenance: AssetProvenance;
  readonly safety: readonly AssetSafetyVerdict[];
}

async function quarantine(
  internals: AssetInternals,
  plan: AdmissionPlan,
  measured: Measured,
): Promise<never> {
  const flagged = measured.safety.find((verdict) => verdict.verdict === 'flagged')!;
  await internals.withLock(plan.assetId, async () => {
    const loaded = await loadRecord(internals.storage, plan.assetId);
    if (!loaded || loaded.record.state !== 'pending') return;
    const next: AssetRecord = {
      ...loaded.record,
      revision: loaded.record.revision + 1,
      state: 'quarantined',
      digest: measured.digest,
      mediaType: measured.mediaType,
      byteLength: measured.bytes.byteLength,
      media: measured.facts,
      provenance: measured.provenance,
      safety: measured.safety,
      rejection: { code: 'safety-gate-flagged', message: 'A safety gate flagged the content.' },
      updatedAt: internals.nowIso(),
      tombstoneUntil: internals.isoAfter(internals.policy.tombstoneRetentionMilliseconds),
    };
    await replaceRecord(internals.storage, loaded, next);
    await internals.emit({
      type: 'asset.quarantined',
      assetId: plan.assetId,
      revision: next.revision,
      state: 'quarantined',
      code: 'safety-gate-flagged',
      digest: measured.digest,
      gate: flagged.gate,
      category: flagged.category,
    });
  });
  throw new AssetAdmissionError('safety-gate-flagged', 'A safety gate flagged the content.');
}

/** Applies the duplicate policy; returns the existing asset's descriptor when the policy reuses it. */
async function applyDuplicatePolicy(
  internals: AssetInternals,
  plan: AdmissionPlan,
  digest: string,
): Promise<AssetDescriptor | undefined> {
  const policy = internals.policy.duplicatePolicy;
  if (policy === 'store-separately') return undefined;
  const existingId = await internals.storage.get(KEYS.digestIndex(plan.principal.id, digest));
  if (existingId === null || existingId === plan.assetId) return undefined;
  const existing = await loadRecord(internals.storage, existingId);
  if (!existing || existing.record.state !== 'available') return undefined;
  if (policy === 'reject') {
    throw new AssetAdmissionError('duplicate', 'An identical asset already exists for this owner.');
  }
  await settleRejected(
    internals,
    plan.assetId,
    { code: 'duplicate', message: 'An identical asset already exists; it was reused.' },
    { duplicateOf: existingId, digest },
  );
  return projectFor(existing.record, plan.principal);
}

async function commit(
  internals: AssetInternals,
  plan: AdmissionPlan,
  context: AssetWorkContext,
  measured: Measured,
): Promise<AssetDescriptor> {
  const { storage } = internals;
  // Staging lease: garbage collection must not purge the blob between its write and the commit that owns it.
  const release = internals.leases.acquire(measured.digest);
  try {
    const blobKey = KEYS.blob(measured.digest);
    // Under the blob's lock, which collection takes to purge it: a purge in flight finishes first, and the blob is rewritten.
    await internals.withLock(blobKey, async () => {
      if ((await context.track(storage.get(blobKey))) === null) {
        await context.track(storage.set(blobKey, encodeBase64(measured.bytes)));
      }
    });
    // The commit itself is the point of no return: it is not raced against abort.
    return await internals.withLock(plan.assetId, async () => {
      const loaded = await loadRecord(storage, plan.assetId);
      if (!loaded || loaded.record.state !== 'pending') {
        throw new AssetAdmissionError(
          'storage-failure',
          'The pending record changed during admission.',
        );
      }
      const next: AssetRecord = {
        ...loaded.record,
        revision: loaded.record.revision + 1,
        state: 'available',
        digest: measured.digest,
        mediaType: measured.mediaType,
        byteLength: measured.bytes.byteLength,
        media: measured.facts,
        provenance: measured.provenance,
        safety: measured.safety,
        updatedAt: internals.nowIso(),
      };
      await replaceRecord(storage, loaded, next, [
        { type: 'set', key: KEYS.owner(measured.digest, plan.assetId), value: '' },
        { type: 'set', key: KEYS.digestIndex(next.ownerId, measured.digest), value: plan.assetId },
      ]);
      await internals.emit({
        type: 'asset.available',
        assetId: plan.assetId,
        revision: next.revision,
        state: 'available',
        digest: measured.digest,
        mediaType: measured.mediaType,
        byteLength: measured.bytes.byteLength,
        ...(measured.provenance.kind === 'url' ? { origin: measured.provenance.origin } : {}),
      });
      return projectFor(next, plan.principal);
    });
  } finally {
    release();
  }
}

/**
 * Bureau never holds a provider-fetch declaration's bytes, so nothing about
 * them can be inspected. The declaration must name its media type, and it is
 * refused outright when a configured gate or limit would have to inspect
 * those bytes: a safety gate, or a `MediaLimits` entry for its modality.
 */
function refuseUninspectableProviderFetch(
  internals: AssetInternals,
  declared: string | undefined,
): asserts declared is string {
  const refuse = (message: string) =>
    new AssetAdmissionError('provider-fetch-not-allowed', message);
  if (declared === undefined) {
    throw refuse('A provider-fetch declaration must declare its media type.');
  }
  if ((internals.ports.safetyGates ?? []).length > 0) {
    throw refuse('Configured safety gates cannot inspect bytes a provider fetches.');
  }
  const modality = modalityOf(declared);
  if (internals.policy.limits.some((limit) => limit.modality === modality)) {
    throw refuse(`Configured ${modality} limits cannot measure bytes a provider fetches.`);
  }
}

async function commitProviderFetch(
  internals: AssetInternals,
  plan: AdmissionPlan,
  url: string,
): Promise<AssetDescriptor> {
  const declared = plan.declaredMediaType;
  refuseUninspectableProviderFetch(internals, declared);
  const allowed = internals.policy.allowedMediaTypes;
  if (allowed !== undefined && !allowed.map(normalizeMediaType).includes(declared)) {
    throw new AssetAdmissionError(
      'media-type-not-allowed',
      'The declared media type is not allowed.',
    );
  }
  return internals.withLock(plan.assetId, async () => {
    const loaded = await loadRecord(internals.storage, plan.assetId);
    if (!loaded || loaded.record.state !== 'pending') {
      throw new AssetAdmissionError(
        'storage-failure',
        'The pending record changed during admission.',
      );
    }
    const origin = originOf(url);
    const next: AssetRecord = {
      ...loaded.record,
      revision: loaded.record.revision + 1,
      state: 'available',
      mediaType: plan.declaredMediaType,
      providerFetchUrl: url,
      provenance: { kind: 'url', origin, fetchedBy: 'provider', redirects: 0 },
      updatedAt: internals.nowIso(),
    };
    await replaceRecord(internals.storage, loaded, next);
    await internals.emit({
      type: 'asset.available',
      assetId: plan.assetId,
      revision: next.revision,
      state: 'available',
      mediaType: plan.declaredMediaType,
      origin,
    });
    return projectFor(next, plan.principal);
  });
}

async function measure(
  internals: AssetInternals,
  plan: AdmissionPlan,
  context: AssetWorkContext,
  acquired: AcquiredBytes,
): Promise<Measured> {
  const { bytes } = acquired;
  const digest = `sha256:${await context.track(sha256BytesHex(bytes))}`;
  const { mediaType, facts } = await inspect(
    internals,
    context,
    bytes,
    plan.declaredMediaType ?? acquired.contentType,
  );
  const modality = modalityOf(mediaType);
  checkPerPartLimits(internals.policy.limits, modality, bytes.byteLength, facts);
  if (plan.budget) {
    const fits = await plan.budget.reserve(
      plan.slot,
      modality,
      {
        bytes: bytes.byteLength,
        durationSeconds: facts.durationSeconds ?? 0,
        pageCount: facts.pageCount ?? 0,
      },
      context.signal,
    );
    if (!fits) {
      throw new AssetAdmissionError(
        'aggregate-limit-exceeded',
        'The parts together exceed an aggregate limit.',
      );
    }
  }
  const safety = await scan(internals, context, bytes, mediaType, digest);
  return { bytes, digest, mediaType, facts, provenance: acquired.provenance, safety };
}

async function runAdmission(
  internals: AssetInternals,
  plan: AdmissionPlan,
  context: AssetWorkContext,
): Promise<AssetDescriptor> {
  try {
    const acquired = await acquire(internals, plan, context);
    if (acquired.kind === 'provider-fetch')
      return await commitProviderFetch(internals, plan, acquired.url);
    if (acquired.bytes.byteLength > internals.policy.maxAssetBytes) {
      throw new AssetAdmissionError(
        'per-part-limit-exceeded',
        `The asset exceeds the ${internals.policy.maxAssetBytes}-byte ceiling.`,
      );
    }
    const measured = await measure(internals, plan, context, acquired);
    if (measured.safety.some((verdict) => verdict.verdict === 'flagged'))
      await quarantine(internals, plan, measured);
    const commitUnderDuplicatePolicy = async () =>
      (await applyDuplicatePolicy(internals, plan, measured.digest)) ??
      commit(internals, plan, context, measured);
    if (internals.policy.duplicatePolicy === 'store-separately')
      return await commitUnderDuplicatePolicy();
    return await internals.withLock(
      KEYS.digestIndex(plan.principal.id, measured.digest),
      commitUnderDuplicatePolicy,
    );
  } catch (error) {
    const rejection = context.signal.aborted
      ? { code: 'aborted' as const, message: 'The admission was aborted.' }
      : classifyFailure(error);
    await settleRejected(internals, plan.assetId, rejection);
    throw error;
  } finally {
    plan.budget?.skip(plan.slot);
  }
}
