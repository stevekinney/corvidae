/**
 * `bureau.assets.*`: upload and read Bureau's managed assets (COR-1547) over the lifecycle
 * `AssetService` already owns (`assets/`).
 *
 * - `bureau.assets.uploads.create` begins an upload session for a declared length and media type.
 * - `bureau.assets.uploads.append` adds one base64 chunk to it.
 * - `bureau.assets.uploads.complete` admits the session as an asset and answers only once the
 *   asset has settled: with a descriptor in state `available`, or with a typed fault when the
 *   asset was rejected or quarantined. No call answers while the asset is `pending`.
 * - `bureau.assets.get` reads one asset's descriptor.
 *
 * An upload session admits exactly one asset (COR-1609). A completion claims the session; one that
 * loses, or arrives while another is in flight, is answered `Conflict`. A retried completion of a
 * session already completed is answered the settled outcome of the asset it admitted, until the
 * session expires, so a client whose answer was lost can recover the asset id.
 *
 * The bytes themselves are served by `GET /assets/{assetId}/content` (`assets-mount.ts`).
 *
 * The two scopes, `bureau.assets:read` and `bureau.assets:write`, gate who may call; they grant
 * nothing across owners. `AssetService` authorizes by owner and readers alone, as the owner string
 * the caller's credential names (`ownerOfPrincipal`), the same owner a run's assets and an AG-UI
 * chat's attachments are admitted under. An asset or upload session another owner holds is
 * answered exactly as a missing one. `abortUpload` is deliberately not served in v1: a session
 * that is never completed expires.
 *
 * @module assets-operations
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import { decodeBase64 } from '../../assets/base64.ts';
import {
  AssetAdmissionError,
  AssetConflictError,
  AssetNotFoundError,
  AssetServiceClosedError,
} from '../../assets/errors.ts';
import type {
  AssetDescriptor,
  AssetPrincipal,
  AssetService,
  AssetUploadSession,
} from '../../assets/types.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What the asset operations read from the handler's `host`. */
export type BureauAssetsOperationHost = {
  /** The Bureau's asset service, or `undefined` for a host built over a Bureau that has none. */
  readonly assets: AssetService | undefined;
};

/** A strict base64 string: whole quads, with `=` padding only at the end. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const write = {
  kind: 'scoped',
  scopes: { kind: 'allOf', scopes: ['bureau.assets:write'] },
} as const;
const read = {
  kind: 'scoped',
  scopes: { kind: 'allOf', scopes: ['bureau.assets:read'] },
} as const;

/** The principal the asset service sees: the owner string the caller's credential names. */
function assetPrincipalOf(
  host: BureauAssetsOperationHost,
  principal: Principal,
  resource: 'asset' | 'upload',
  identifier: string,
): { readonly service: AssetService; readonly caller: AssetPrincipal } {
  const owner = ownerOfPrincipal(principal);
  if (host.assets === undefined) {
    throw {
      code: 'UnsupportedCapability',
      message: 'This Bureau keeps no managed assets',
      data: { capability: 'assets' },
    } satisfies OperationFault;
  }
  // A caller that can own nothing (a credential with no subject) reaches nothing.
  if (owner === undefined) throw resourceNotFound(resource, identifier);
  return { service: host.assets, caller: { id: owner } };
}

/**
 * The fault an asset error is answered with. A missing asset or session, and one the caller may
 * not see, are the same `NotFound`; a refused admission is `Unprocessable` with the asset's
 * rejection code in `data.reason`; a write that lost to a concurrent one is `Conflict`. Anything else is not the caller's doing and is rethrown.
 */
function faultOf(error: unknown, resource: 'asset' | 'upload', identifier: string): unknown {
  if (error instanceof AssetNotFoundError) return resourceNotFound(resource, identifier);
  if (error instanceof AssetAdmissionError) {
    return {
      code: 'Unprocessable',
      message: error.message,
      data: { reason: error.code },
    } satisfies OperationFault;
  }
  if (error instanceof AssetConflictError) {
    // The storage key stays out of the message: it names the caller's own resource and nothing more.
    return {
      code: 'Conflict',
      message: `${resource === 'upload' ? 'Upload' : 'Asset'} "${identifier}" was changed by another request; read it again before retrying`,
      data: { reason: 'concurrent-write' },
    } satisfies OperationFault;
  }
  if (error instanceof AssetServiceClosedError) {
    return {
      code: 'Unavailable',
      message: 'The asset service has shut down',
      data: {},
    } satisfies OperationFault;
  }
  return error;
}

async function asFault<T>(
  resource: 'asset' | 'upload',
  identifier: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw faultOf(error, resource, identifier);
  }
}

const uploadSchema = z.object({
  uploadId: z.string(),
  declaredMediaType: z.string().nullable(),
  declaredByteLength: z.number().int().positive(),
  receivedBytes: z.number().int().nonnegative(),
  state: z.literal('open'),
  createdAt: z.string(),
  expiresAt: z.string(),
});

function uploadView(session: AssetUploadSession): z.infer<typeof uploadSchema> {
  return {
    uploadId: session.uploadId,
    declaredMediaType: session.declaredMediaType ?? null,
    declaredByteLength: session.declaredByteLength,
    receivedBytes: session.receivedBytes,
    state: session.state,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

/** An asset as any authorized reader sees it: the general projection, with no owner or retention detail. */
export const assetViewSchema = z.object({
  assetId: z.string(),
  revision: z.number().int().positive(),
  state: z.enum(['pending', 'available', 'rejected', 'quarantined', 'expired', 'deleted']),
  custody: z.enum(['bureau', 'provider-fetch']),
  digest: z.string().nullable(),
  mediaType: z.string().nullable(),
  modality: z.string().nullable(),
  mimeFamily: z.string().nullable(),
  byteLength: z.number().int().nonnegative().nullable(),
  provenanceKind: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
  /** Why the asset was refused, by stable code; never any content or URL. */
  rejection: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** The caller's own access: its owner, or a reader the owner named. */
  access: z.enum(['owner', 'reader']),
});

function assetView(descriptor: AssetDescriptor): z.infer<typeof assetViewSchema> {
  return {
    assetId: descriptor.assetId,
    revision: descriptor.revision,
    state: descriptor.state,
    custody: descriptor.custody,
    digest: descriptor.digest ?? null,
    mediaType: descriptor.mediaType ?? null,
    modality: descriptor.modality ?? null,
    mimeFamily: descriptor.mimeFamily ?? null,
    byteLength: descriptor.byteLength ?? null,
    provenanceKind: descriptor.provenanceKind,
    createdAt: descriptor.createdAt,
    updatedAt: descriptor.updatedAt,
    expiresAt: descriptor.expiresAt ?? null,
    rejection:
      descriptor.rejection === undefined
        ? null
        : { code: descriptor.rejection.code, message: descriptor.rejection.message },
    access: descriptor.projection === 'general' ? descriptor.authorization.access : 'owner',
  };
}

const createInput = z.object({
  declaredByteLength: z
    .number()
    .int()
    .positive()
    .describe(
      'The number of bytes the upload will carry. A length above the policy’s ceiling is refused.',
    ),
  declaredMediaType: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'The media type the caller expects. The content is inspected and the detected type wins; a declared type that disagrees with it is refused when the upload completes.',
    ),
});

export const assetsUploadsCreateOperation = defineOperation<
  typeof createInput,
  typeof uploadSchema,
  BureauAssetsOperationHost
>({
  name: 'bureau.assets.uploads.create',
  mcpExposable: false,
  summary: 'Begin an asset upload',
  description:
    'Begins an upload session the caller owns, for `declaredByteLength` bytes of `declaredMediaType` (optional: the content is inspected and the detected type wins, and a declared type that disagrees with it is refused when the upload completes). A length above the policy’s ceiling is refused here, before anything is stored. Requires `bureau.assets:write`. Append the bytes with `bureau.assets.uploads.append` and finish with `bureau.assets.uploads.complete`; a session never completed expires.',
  destructive: false,
  tags: ['Assets'],
  inputSchema: createInput,
  outputSchema: uploadSchema,
  producibleFaults: ['InvalidParams', 'Unprocessable', 'UnsupportedCapability', 'Unavailable'],
  access: write,
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { service, caller } = assetPrincipalOf(host, principal, 'upload', 'new');
    const session = await asFault('upload', 'new', () =>
      service.beginUpload(caller, {
        declaredByteLength: input.declaredByteLength,
        ...(input.declaredMediaType === undefined
          ? {}
          : { declaredMediaType: input.declaredMediaType }),
      }),
    );
    return uploadView(session);
  },
});

const appendInput = z.object({
  uploadId: z.string().min(1).describe('The identifier of the open upload to append to.'),
  chunk: z
    .string()
    .min(1)
    .regex(BASE64, 'chunk must be base64')
    .describe('The next chunk of the upload’s bytes, base64-encoded.'),
});

export const assetsUploadsAppendOperation = defineOperation<
  typeof appendInput,
  typeof uploadSchema,
  BureauAssetsOperationHost
>({
  name: 'bureau.assets.uploads.append',
  mcpExposable: false,
  summary: 'Append a chunk to an asset upload',
  description:
    'Appends one base64 chunk to the caller’s own open upload and answers the session with its `receivedBytes`. A chunk that is not base64 is `InvalidParams`; a chunk larger than the handler’s `maxRequestBodyBytes` is refused with 413 before the operation runs. A chunk that would take the session past its declared length, and an empty one, are refused and nothing is stored. A session another owner holds, one that is not open, and one that does not exist are all `NotFound`. An append that loses to another append to the same session, in this process or any other sharing the store, is `Conflict` with `data.reason: "concurrent-write"`: nothing of it is stored, and the session holds only the chunk that won. A session that already holds a chunk at the next index (left by a writer that stored the chunk and died before it recorded it) answers every append `Conflict` until it expires (an embedding host can also abort it through `AssetService.abortUpload`; the management plane does not serve abort). A session holds at most 9999 chunks: the append that would exceed that is refused as `Unprocessable` with `reason: "per-part-limit-exceeded"` and stores nothing, so a client sends chunks large enough to fit its declared length in 9999. Requires `bureau.assets:write`.',
  destructive: false,
  tags: ['Assets'],
  inputSchema: appendInput,
  outputSchema: uploadSchema,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'Conflict',
    'Unprocessable',
    'UnsupportedCapability',
    'Unavailable',
  ],
  access: write,
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { service, caller } = assetPrincipalOf(host, principal, 'upload', input.uploadId);
    const bytes = decodeBase64(input.chunk);
    const session = await asFault('upload', input.uploadId, () =>
      service.appendUpload(input.uploadId, caller, bytes),
    );
    return uploadView(session);
  },
});

const completeInput = z.object({
  uploadId: z.string().min(1).describe('The identifier of the upload to complete.'),
});

export const assetsUploadsCompleteOperation = defineOperation<
  typeof completeInput,
  typeof assetViewSchema,
  BureauAssetsOperationHost
>({
  name: 'bureau.assets.uploads.complete',
  mcpExposable: false,
  summary: 'Complete an asset upload',
  description:
    'Admits the caller’s own upload as an asset and answers once the asset has settled, never while it is `pending`: with its descriptor, in state `available`, or with an `Unprocessable` fault whose `data.reason` is the asset’s rejection code (for example `media-type-mismatch` or `safety-gate-flagged`) and whose message names the asset and says whether it was `rejected` or `quarantined`. A session that is not complete (fewer bytes than declared) is refused with `reason: "upload-incomplete"` and stays open, so the missing bytes can still be appended. Completing claims the session: a completion that arrives while another is in flight, or that loses the claim to one in another process, is `Conflict` and admits nothing. A completion retried after the session completed is answered from the current state of the asset the session admitted (the asset it reused, under the `reuse` duplicate policy): its descriptor when `available`, an `Unprocessable` fault carrying the rejection it recorded when refused, and `Unavailable` when the asset has since expired or been deleted, until the session expires; a retry that finds the first still in flight, before its asset has settled, is `Conflict`. A session another owner holds, an expired or purged one, and a missing one are `NotFound`. Requires `bureau.assets:write`.',
  destructive: false,
  tags: ['Assets'],
  inputSchema: completeInput,
  outputSchema: assetViewSchema,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'Conflict',
    'Unprocessable',
    'UnsupportedCapability',
    'Unavailable',
  ],
  access: write,
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { uploadId } = input;
    const { service, caller } = assetPrincipalOf(host, principal, 'upload', uploadId);
    // Asked first: a refused completion must not start an admission, and so leave a rejected
    // asset behind, for a session the caller does not hold. A session already completed is a
    // retry, answered from the asset it admitted; one in flight answers `Conflict` here.
    const settledAssetId = await asFault('upload', uploadId, () =>
      service.completedUploadAssetId(uploadId, caller),
    );
    if (settledAssetId !== undefined) {
      return answerFor(service, caller, uploadId, settledAssetId, 'replayed');
    }
    const admission = await asFault('upload', uploadId, () =>
      service.admit({ source: { kind: 'upload', uploadId } }, caller),
    );
    const outcome = await admission.work.result();
    // Under the `reuse` duplicate policy the admission's own asset is retired and its work
    // completes with the asset it matched: that is the one the caller can use.
    const assetId = outcome.outcome === 'completed' ? outcome.value.assetId : admission.assetId;
    return answerFor(service, caller, uploadId, assetId, outcome.outcome);
  },
});

/**
 * The answer for a completion that admitted `assetId`: its descriptor when `available`, otherwise
 * the fault the asset's state calls for. A replay (`outcome: 'replayed'`) answers from the asset's
 * state as it is now, so it can differ from the first call's answer (an asset deleted since reads
 * `Unavailable`), and a replay finding the asset still `pending` is another completion's
 * in-flight work: `Conflict`.
 */
async function answerFor(
  service: AssetService,
  caller: AssetPrincipal,
  uploadId: string,
  assetId: string,
  outcome: string,
): Promise<z.infer<typeof assetViewSchema>> {
  const descriptor = await asFault('asset', assetId, () => service.inspect(assetId, caller));
  if (descriptor.state === 'available') return assetView(descriptor);
  if (descriptor.state === 'pending' && outcome === 'replayed') {
    throw faultOf(new AssetConflictError(uploadId), 'upload', uploadId);
  }
  if (descriptor.state === 'rejected' || descriptor.state === 'quarantined') {
    const code = descriptor.rejection?.code ?? 'unknown';
    // The session was retired between the check above and the admission reading it.
    if (code === 'source-not-available') throw resourceNotFound('upload', uploadId);
    throw {
      code: 'Unprocessable',
      message: `Asset "${descriptor.assetId}" was ${descriptor.state}: ${descriptor.rejection?.message ?? code}`,
      data: { reason: code },
    } satisfies OperationFault;
  }
  // Aborted by a shutdown, or expired or deleted the moment it settled: it is not an asset
  // the caller can use, and not something the caller did wrong.
  throw {
    code: 'Unavailable',
    // A replay re-reads the asset's current state, so it has no first-call outcome to name.
    message: `Asset "${descriptor.assetId}" is ${descriptor.state}${outcome === 'replayed' ? '' : ` (${outcome})`}`,
    data: { reason: `asset-${descriptor.state}` },
  } satisfies OperationFault;
}

const getInput = z.object({
  assetId: z.string().min(1).describe('The identifier of the asset to read.'),
});

export const assetsGetOperation = defineOperation<
  typeof getInput,
  typeof assetViewSchema,
  BureauAssetsOperationHost
>({
  name: 'bureau.assets.get',
  mcpExposable: false,
  summary: 'Read one asset',
  description:
    'Returns the descriptor of one asset the caller owns or may read, in any state, including `pending` and a refused one, which carries its `rejection`. It never carries the bytes: `GET /assets/{assetId}/content` serves them. An asset another owner holds and one that does not exist are both `NotFound`. Requires `bureau.assets:read`.',
  destructive: false,
  tags: ['Assets'],
  inputSchema: getInput,
  outputSchema: assetViewSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability', 'Unavailable'],
  access: read,
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { service, caller } = assetPrincipalOf(host, principal, 'asset', input.assetId);
    return assetView(
      await asFault('asset', input.assetId, () => service.inspect(input.assetId, caller)),
    );
  },
});

/** The asset operations, in the order the handler serves them. */
export const bureauAssetsOperations = [
  assetsUploadsCreateOperation,
  assetsUploadsAppendOperation,
  assetsUploadsCompleteOperation,
  assetsGetOperation,
] as const;
