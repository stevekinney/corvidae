/**
 * Upload sessions (COR-794): a caller begins a session declaring the total
 * byte length, appends chunks, and completes it by admitting
 * `{ kind: 'upload', uploadId }`. A session that is never completed is a
 * partial upload: garbage collection purges it with its chunks once its
 * time-to-live passes, and `abortUpload` purges it at once.
 *
 * Sessions are owner-scoped; any other principal is told the session does
 * not exist.
 *
 * A session admits exactly one asset, however many processes share the store
 * and however often the caller retries (COR-1609). Every transition is a
 * compare-and-swap guarded on the session record's raw JSON, so the in-process
 * lock is only an optimisation: an append writes its chunk and advances the
 * record in one `conditionalBatch`, a completion claims the session (`open` to
 * `completing`) before it reads a chunk, and an abort deletes the chunks and
 * the record in one `conditionalBatch`. See {@link UploadSessionRecord}.
 */
import { MAX_BATCH_OPERATIONS } from '@lostgradient/storage';

import { encodeBase64 } from './base64';
import { AssetAdmissionError, AssetConflictError, AssetNotFoundError } from './errors';
import type { AssetInternals } from './internals';
import { modalityOf, normalizeMediaType } from './media-inspection';
import { KEYS, loadRecord } from './records';
import type { AssetPolicy, AssetPrincipal, AssetUploadSession } from './types';

/**
 * The persisted upload session (`asset:v1:upload:<uploadId>`).
 *
 * Additive over the COR-794 shape: a record written before COR-1609 has
 * `state: 'open'` and no `assetId`, and loads unchanged.
 */
/**
 * The most chunks a session may hold. Completing a session writes its terminal record and deletes
 * every chunk in one `conditionalBatch`, and aborting it deletes every chunk and the record in
 * another; each batch carries one operation beyond the chunks, and a durable Weft backend refuses a
 * batch of more than `MAX_BATCH_OPERATIONS`. Bounding the count where the session is written keeps
 * both batches under the cap, so no session can be stranded where it can be neither completed nor
 * aborted.
 */
export const MAX_UPLOAD_CHUNKS = MAX_BATCH_OPERATIONS - 1;

export interface UploadSessionRecord {
  readonly uploadId: string;
  readonly ownerId: string;
  readonly declaredMediaType?: string | undefined;
  readonly declaredByteLength: number;
  readonly receivedBytes: number;
  readonly chunkCount: number;
  /**
   * - `open`: accepts chunks, and a completion may claim it.
   * - `completing`: a completion claimed it and is reading the chunks. It answers `Conflict` to
   *   another completion and accepts no chunk. It returns to `open` when the completion fails
   *   before consuming the chunks (an incomplete upload, an abort), and is purged with the
   *   session at `expiresAt` when its claimer died.
   * - `completed`: the chunks are the asset's bytes and are deleted. The record stays, as the
   *   terminal outcome a retried completion replays, until `expiresAt`, when collection purges it.
   */
  readonly state: 'open' | 'completing' | 'completed';
  /**
   * The asset the completion admits: written by the claim and kept by the terminal record. Absent
   * while the session is `open`, and on any record written before COR-1609.
   */
  readonly assetId?: string | undefined;
  readonly createdAt: string;
  readonly expiresAt: string;
}

function project(session: UploadSessionRecord): AssetUploadSession {
  return Object.freeze({
    uploadId: session.uploadId,
    declaredMediaType: session.declaredMediaType,
    declaredByteLength: session.declaredByteLength,
    receivedBytes: session.receivedBytes,
    state: 'open',
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
}

/** A session as stored: the parsed record with the exact text it was parsed from, which every compare-and-swap guards on. */
interface LoadedSession {
  readonly session: UploadSessionRecord;
  readonly raw: string;
}

/** The owner's unexpired session in any state, or {@link AssetNotFoundError}: a stranger, a missing session, and an expired one read alike. */
async function loadSession(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<LoadedSession> {
  const raw = await internals.storage.get(KEYS.upload(uploadId));
  const session = raw === null ? undefined : (JSON.parse(raw) as UploadSessionRecord);
  if (
    raw === null ||
    !session ||
    session.ownerId !== principal.id ||
    Date.parse(session.expiresAt) <= internals.now()
  ) {
    throw new AssetNotFoundError(uploadId);
  }
  return { session, raw };
}

async function loadOpenSession(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<LoadedSession> {
  const loaded = await loadSession(internals, uploadId, principal);
  if (loaded.session.state !== 'open') throw new AssetNotFoundError(uploadId);
  return loaded;
}

/** Replaces the session record `previous` with `next`, only if it is still exactly `previous`. */
async function swapSession(
  internals: AssetInternals,
  uploadId: string,
  previousRaw: string,
  next: UploadSessionRecord,
): Promise<boolean> {
  const key = KEYS.upload(uploadId);
  return internals.storage.conditionalBatch(
    [{ key, expectedValue: previousRaw }],
    [{ type: 'set', key, value: JSON.stringify(next) }],
  );
}

/** The most bytes an upload may declare: the asset ceiling, and any per-part byte limit for the declared type's modality. */
function uploadCeiling(policy: AssetPolicy, declaredMediaType: string | undefined): number {
  let ceiling = policy.maxAssetBytes;
  if (declaredMediaType === undefined) return ceiling;
  const modality = modalityOf(normalizeMediaType(declaredMediaType));
  for (const limit of policy.limits) {
    if (limit.scope === 'per-part' && limit.modality === modality && limit.maxBytes !== undefined)
      ceiling = Math.min(ceiling, limit.maxBytes);
  }
  return ceiling;
}

export async function beginUpload(
  internals: AssetInternals,
  principal: AssetPrincipal,
  request: { readonly declaredMediaType?: string | undefined; readonly declaredByteLength: number },
): Promise<AssetUploadSession> {
  if (!Number.isSafeInteger(request.declaredByteLength) || request.declaredByteLength <= 0) {
    throw new AssetAdmissionError(
      'upload-incomplete',
      'An upload must declare a positive byte length.',
    );
  }
  const ceiling = uploadCeiling(internals.policy, request.declaredMediaType);
  if (request.declaredByteLength > ceiling) {
    throw new AssetAdmissionError(
      'per-part-limit-exceeded',
      `The upload declares more than the ${ceiling}-byte ceiling.`,
    );
  }
  const uploadId = internals.runtime.identifiers.next('asset-upload');
  const session: UploadSessionRecord = {
    uploadId,
    ownerId: principal.id,
    declaredMediaType: request.declaredMediaType,
    declaredByteLength: request.declaredByteLength,
    receivedBytes: 0,
    chunkCount: 0,
    state: 'open',
    createdAt: internals.nowIso(),
    expiresAt: internals.isoAfter(internals.policy.uploadSessionTtlMilliseconds),
  };
  await internals.storage.set(KEYS.upload(uploadId), JSON.stringify(session));
  await internals.emit({ type: 'asset.upload.started', uploadId, principal: principal.id });
  return project(session);
}

export async function inspectUpload(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<AssetUploadSession> {
  const { session } = await loadOpenSession(internals, uploadId, principal);
  return project(session);
}

export function appendUpload(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
  bytes: Uint8Array,
): Promise<AssetUploadSession> {
  return internals.withLock(`upload:${uploadId}`, async () => {
    const { session, raw } = await loadOpenSession(internals, uploadId, principal);
    // An empty chunk would add a stored key without advancing the byte count, unbounded.
    if (bytes.byteLength === 0) {
      throw new AssetAdmissionError('upload-incomplete', 'An upload chunk must not be empty.');
    }
    if (session.receivedBytes + bytes.byteLength > session.declaredByteLength) {
      throw new AssetAdmissionError(
        'per-part-limit-exceeded',
        'The chunk exceeds the declared byte length.',
      );
    }
    if (session.chunkCount >= MAX_UPLOAD_CHUNKS) {
      throw new AssetAdmissionError(
        'per-part-limit-exceeded',
        `An upload holds at most ${MAX_UPLOAD_CHUNKS} chunks; send larger chunks.`,
      );
    }
    const next: UploadSessionRecord = {
      ...session,
      receivedBytes: session.receivedBytes + bytes.byteLength,
      chunkCount: session.chunkCount + 1,
    };
    // One atomic step, guarded on the record this append read and on its chunk key being free:
    // - the record condition makes an append that read the session before another process
    //   appended, completed or aborted it lose, whatever else changed since;
    // - the chunk condition keeps an existing chunk at this index (the residue of a writer that
    //   stored the chunk and died before it wrote the record) from being overwritten. Such a
    //   session answers `Conflict` to every append until its owner aborts it or it expires.
    // A losing append stores nothing and answers `Conflict`.
    const sessionKey = KEYS.upload(uploadId);
    const chunkKey = KEYS.chunk(uploadId, session.chunkCount);
    const committed = await internals.storage.conditionalBatch(
      [
        { key: sessionKey, expectedValue: raw },
        { key: chunkKey, expectedValue: null },
      ],
      [
        { type: 'set', key: chunkKey, value: encodeBase64(bytes) },
        { type: 'set', key: sessionKey, value: JSON.stringify(next) },
      ],
    );
    if (!committed) throw new AssetConflictError(sessionKey);
    return project(next);
  });
}

/**
 * Claims the owner's open session for the admission `assetId`: the compare-and-swap from `open`
 * to `{ state: 'completing', assetId }`. Taken before the admission's asset record exists, so a
 * completion that loses persists nothing to reject. A session already claimed or completed, and a
 * claim another process won first, answer {@link AssetConflictError}.
 */
export function claimUpload(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
  assetId: string,
): Promise<void> {
  return internals.withLock(`upload:${uploadId}`, async () => {
    const { session, raw } = await loadSession(internals, uploadId, principal);
    const conflict = new AssetConflictError(KEYS.upload(uploadId));
    if (session.state !== 'open') throw conflict;
    const claimed: UploadSessionRecord = { ...session, state: 'completing', assetId };
    if (!(await swapSession(internals, uploadId, raw, claimed))) throw conflict;
  });
}

/**
 * Gives a claim back: `completing` for `assetId` returns to `open`, so a completion that failed
 * before it consumed the chunks (an incomplete upload, an abort) leaves the session appendable. A
 * session in any other state, or claimed by another admission, is left as it is. Best-effort: when
 * the write fails the claim stays until the session expires, which is what a dead claimer leaves.
 */
export async function reopenUpload(
  internals: AssetInternals,
  uploadId: string,
  assetId: string,
): Promise<void> {
  try {
    await internals.withLock(`upload:${uploadId}`, async () => {
      const raw = await internals.storage.get(KEYS.upload(uploadId));
      if (raw === null) return;
      const session = JSON.parse(raw) as UploadSessionRecord;
      if (session.state !== 'completing' || session.assetId !== assetId) return;
      const { assetId: _claimed, ...open } = session;
      await swapSession(internals, uploadId, raw, { ...open, state: 'open' });
    });
  } catch {
    // The claim expires with the session.
  }
}

/**
 * The asset a retried completion is answered with: the one the session's completion admitted, or
 * the asset it reused when the duplicate policy retired the admission's own. `undefined` while the
 * session is still open. A session whose completion is in flight answers
 * {@link AssetConflictError}; one that is missing, held by another owner, or expired answers
 * {@link AssetNotFoundError}.
 */
export async function completedUploadAssetId(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<string | undefined> {
  const { session } = await loadSession(internals, uploadId, principal);
  if (session.state === 'open') return undefined;
  if (session.state === 'completing') throw new AssetConflictError(KEYS.upload(uploadId));
  if (session.assetId === undefined) throw new AssetNotFoundError(uploadId);
  const admitted = await loadRecord(internals.storage, session.assetId);
  // A reused duplicate: the admission's own asset was retired in favour of the one it matched.
  if (
    admitted?.record.state === 'rejected' &&
    admitted.record.rejection?.code === 'duplicate' &&
    admitted.record.duplicateOf !== undefined
  ) {
    return admitted.record.duplicateOf;
  }
  return session.assetId;
}

export function abortUpload(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<void> {
  return internals.withLock(`upload:${uploadId}`, async () => {
    const { raw } = await loadOpenSession(internals, uploadId, principal);
    // One step, guarded on the record this abort read: a completion or an append in another process
    // changes that record first, and the abort then answers `Conflict` and deletes nothing, so it
    // can never remove a terminal record or a chunk it did not list.
    const sessionKey = KEYS.upload(uploadId);
    const chunks = await internals.storage.list(KEYS.chunkPrefix(uploadId));
    const committed = await internals.storage.conditionalBatch(
      [{ key: sessionKey, expectedValue: raw }],
      [
        ...chunks.map((key) => ({ type: 'delete' as const, key })),
        { type: 'delete' as const, key: sessionKey },
      ],
    );
    if (!committed) throw new AssetConflictError(sessionKey);
    await internals.emit({ type: 'asset.upload.aborted', uploadId, principal: principal.id });
  });
}
