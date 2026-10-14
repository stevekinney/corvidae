/**
 * Upload sessions (COR-794): a caller begins a session declaring the total
 * byte length, appends chunks, and completes it by admitting
 * `{ kind: 'upload', uploadId }`. A session that is never completed is a
 * partial upload: garbage collection purges it with its chunks once its
 * time-to-live passes, and `abortUpload` purges it at once.
 *
 * Sessions are owner-scoped; any other principal is told the session does
 * not exist.
 */
import type { UploadSessionRecord } from './admission';
import { encodeBase64 } from './base64';
import { AssetAdmissionError, AssetNotFoundError } from './errors';
import type { AssetInternals } from './internals';
import { modalityOf, normalizeMediaType } from './media-inspection';
import { KEYS } from './records';
import type { AssetPolicy, AssetPrincipal, AssetUploadSession } from './types';

function project(session: UploadSessionRecord): AssetUploadSession {
  return Object.freeze({
    uploadId: session.uploadId,
    declaredMediaType: session.declaredMediaType,
    declaredByteLength: session.declaredByteLength,
    receivedBytes: session.receivedBytes,
    state: session.state,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
}

async function loadOpenSession(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<UploadSessionRecord> {
  const raw = await internals.storage.get(KEYS.upload(uploadId));
  const session = raw === null ? undefined : (JSON.parse(raw) as UploadSessionRecord);
  if (
    !session ||
    session.ownerId !== principal.id ||
    session.state !== 'open' ||
    Date.parse(session.expiresAt) <= internals.now()
  ) {
    throw new AssetNotFoundError(uploadId);
  }
  return session;
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

export function appendUpload(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
  bytes: Uint8Array,
): Promise<AssetUploadSession> {
  return internals.withLock(`upload:${uploadId}`, async () => {
    const session = await loadOpenSession(internals, uploadId, principal);
    if (session.receivedBytes + bytes.byteLength > session.declaredByteLength) {
      throw new AssetAdmissionError(
        'per-part-limit-exceeded',
        'The chunk exceeds the declared byte length.',
      );
    }
    await internals.storage.set(KEYS.chunk(uploadId, session.chunkCount), encodeBase64(bytes));
    const next: UploadSessionRecord = {
      ...session,
      receivedBytes: session.receivedBytes + bytes.byteLength,
      chunkCount: session.chunkCount + 1,
    };
    await internals.storage.set(KEYS.upload(uploadId), JSON.stringify(next));
    return project(next);
  });
}

export function abortUpload(
  internals: AssetInternals,
  uploadId: string,
  principal: AssetPrincipal,
): Promise<void> {
  return internals.withLock(`upload:${uploadId}`, async () => {
    await loadOpenSession(internals, uploadId, principal);
    for (const chunk of await internals.storage.list(KEYS.chunkPrefix(uploadId))) {
      await internals.storage.delete(chunk);
    }
    await internals.storage.delete(KEYS.upload(uploadId));
    await internals.emit({ type: 'asset.upload.aborted', uploadId, principal: principal.id });
  });
}
