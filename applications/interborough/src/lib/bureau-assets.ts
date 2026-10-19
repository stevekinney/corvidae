/**
 * Uploading a file to the Bureau's managed assets (COR-1548), over `bureau.assets.uploads.create`,
 * `append` and `complete` (`packages/bureau/src/http/management/assets-operations.ts`).
 *
 * The bytes go as base64 inside a JSON-RPC body, and the host serves Weft's default 1 MiB limit on
 * that body (`packages/weft/src/server/json-rpc-http.ts`), which base64 grows by a third.
 * {@link UPLOAD_CHUNK_BYTES} keeps one `append` well inside it. The upload is a person's own file
 * going to their own Bureau, so a fault is told to them in the words of {@link AttachmentFaultKind},
 * never as the raw message, which can name an asset or an upload.
 */
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { BUREAU_PATH, callBureau, type Fetcher } from './bureau-client.ts';

/**
 * The words the AG-UI mount and its snapshots use for a managed asset
 * (`packages/bureau/src/http/ag-ui-vocabulary.ts`). A client branches on each, so they are a
 * one-way door on the Bureau's side; the page cannot import them, and the end-to-end suite
 * (`tests/e2e/30-chat-attachments.spec.ts`) holds the two sides to the same strings.
 */
/** The `provider` of the `file` source a user message names an asset with; `value` is the asset id. */
export const ASSET_FILE_PROVIDER = 'bureau';
/** The `name` of the `CUSTOM` event that announces one asset an assistant message carries. */
export const ASSET_PART_EVENT_NAME = 'bureau.asset-part';
/** The `metadata` key an assistant row keeps its assets under, as a list of {@link AssetPartReference}. */
export const ASSET_PARTS_METADATA_KEY = 'bureau:assetParts';

/** One managed asset an assistant message carries: its position in the message's parts, and what it is. */
export type AssetPartReference = {
  readonly index: number;
  readonly assetId: string;
  readonly mediaType: string;
};

/** Where the Bureau serves an asset's bytes. `/assets/*` is the host's own static route. */
export function assetContentPath(assetId: string): string {
  return `${BUREAU_PATH}/assets/${encodeURIComponent(assetId)}/content`;
}

/** Raw bytes in one `append`. Base64 makes the request about 700 KB, under the host's 1 MiB limit. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;

/**
 * What a person is told about an upload that did not finish:
 *
 * - `rejected`: the Bureau looked at the bytes and would not take them (a safety gate flagged the
 *   file, or its content is not the type it says).
 * - `expired`: the upload session was gone when the next chunk or the completion arrived.
 * - `upload-failed`: anything else, such as a body too large, a refusal of the declared length or
 *   type, an unavailable service, or a request that did not arrive.
 * - `too-large`: the file is over the limit the selected agent's model states, found before any
 *   byte was sent.
 */
export type AttachmentFaultKind = 'rejected' | 'expired' | 'upload-failed' | 'too-large';

/** An upload that did not finish, and why, for a person. */
export class AttachmentUploadError extends Error {
  readonly kind: AttachmentFaultKind;
  /** The limit in bytes, for `too-large`. */
  readonly limit: number | undefined;

  constructor(kind: AttachmentFaultKind, options: { cause?: unknown; limit?: number } = {}) {
    super(`Attachment upload failed: ${kind}`, { cause: options.cause });
    this.name = 'AttachmentUploadError';
    this.kind = kind;
    this.limit = options.limit;
  }
}

export type UploadedAsset = {
  readonly assetId: string;
  /** The media type the Bureau detected from the bytes. */
  readonly mediaType: string | null;
};

const sessionSchema = z.object({ uploadId: z.string() });
const assetSchema = z.object({ assetId: z.string(), mediaType: z.string().nullable() });

/** The asset rejection codes a person can do something about: the file itself is the problem. */
const REJECTED_REASONS: ReadonlySet<string> = new Set([
  'safety-gate-flagged',
  'media-type-mismatch',
]);

function reasonOf(error: HttpClientError): string | undefined {
  const reason: unknown = error.data?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** What a fault from `step` is, for a person. */
function faultOf(error: unknown, step: 'create' | 'append' | 'complete'): AttachmentUploadError {
  if (error instanceof HttpClientError) {
    if (error.status === 404 && step !== 'create') {
      return new AttachmentUploadError('expired', { cause: error });
    }
    const reason = reasonOf(error);
    if (step === 'complete' && reason !== undefined && REJECTED_REASONS.has(reason)) {
      return new AttachmentUploadError('rejected', { cause: error });
    }
  }
  return new AttachmentUploadError('upload-failed', { cause: error });
}

const BASE64_STEP = 0x8000;

/** `bytes` as base64. A single `String.fromCharCode(...bytes)` over a whole chunk overflows the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += BASE64_STEP) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_STEP));
  }
  return btoa(binary);
}

/**
 * Uploads `file` and answers the asset it became. Rejects with an {@link AttachmentUploadError}
 * for a fault the Bureau answered, and with the signal's own reason when the signal aborts, in
 * which case nothing more is sent.
 */
export async function uploadAsset(
  file: File,
  options: { readonly signal?: AbortSignal; readonly fetch?: Fetcher } = {},
): Promise<UploadedAsset> {
  const { signal } = options;
  const call = async (
    step: 'create' | 'append' | 'complete',
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    signal?.throwIfAborted();
    try {
      return await callBureau(method, params, {
        ...(signal === undefined ? {} : { signal }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    } catch (error) {
      // An abort is the caller's own doing, not a fault to tell the person about.
      if (signal?.aborted === true) throw error;
      throw faultOf(error, step);
    }
  };

  // The Bureau declines a session for no bytes, and there is nothing to attach in an empty file.
  if (file.size === 0) throw new AttachmentUploadError('upload-failed');
  const session = sessionSchema.parse(
    await call('create', 'bureau.assets.uploads.create', {
      declaredByteLength: file.size,
      ...(file.type === '' ? {} : { declaredMediaType: file.type }),
    }),
  );
  for (let start = 0; start < file.size; start += UPLOAD_CHUNK_BYTES) {
    const chunk = new Uint8Array(await file.slice(start, start + UPLOAD_CHUNK_BYTES).arrayBuffer());
    await call('append', 'bureau.assets.uploads.append', {
      uploadId: session.uploadId,
      chunk: toBase64(chunk),
    });
  }
  return assetSchema.parse(
    await call('complete', 'bureau.assets.uploads.complete', { uploadId: session.uploadId }),
  );
}
