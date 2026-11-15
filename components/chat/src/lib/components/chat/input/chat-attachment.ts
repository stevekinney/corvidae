import type { FileUploadStatus } from '@lostgradient/cinder';

import type { AttachmentKind } from './attachment-kind.ts';

/**
 * What a host's upload hook answers for a file it stored: the host's identifier for it, and its
 * media type when the host detected one. Chat keeps it on the attachment and hands it back on
 * submit; it never reads either field.
 */
export interface ChatAttachmentReference {
  readonly id: string;
  readonly mimeType?: string | undefined;
}

/**
 * Uploads one file when it is attached. The signal aborts when the person removes the attachment
 * or the composer goes away. A rejection puts the attachment in the `error` state, with Retry.
 * `onProgress`, when the hook calls it with the fraction sent so far (0 to 1), turns the tile's
 * moving bar into a percentage.
 */
export type ChatAttachmentUpload = (
  file: File,
  context: {
    readonly signal: AbortSignal;
    readonly onProgress?: ((fraction: number) => void) | undefined;
  },
) => Promise<ChatAttachmentReference>;

/** Why an attachment is in the `error` state. A host's formatter turns it into the words shown. */
export type ChatAttachmentFailure =
  | { readonly kind: 'too-large'; readonly file: File; readonly maxFileSize: number }
  | {
      readonly kind: 'type-not-accepted';
      readonly file: File;
      readonly acceptedTypes: readonly string[];
    }
  | { readonly kind: 'upload-failed'; readonly file: File; readonly error: unknown };

/**
 * What went wrong with a file, in the four ways the composer words differently. `network` is a
 * failure that trying again can fix; `too-large` and `unsupported-type` are about the file, so it
 * can only be removed; `unknown` is anything else, and is tried again.
 */
export type ChatAttachmentFailureKind = 'network' | 'too-large' | 'unsupported-type' | 'unknown';

/** The kinds a failure can be, to tell one from a host's own string. */
export const CHAT_ATTACHMENT_FAILURE_KINDS: readonly ChatAttachmentFailureKind[] = [
  'network',
  'too-large',
  'unsupported-type',
  'unknown',
];

/**
 * What an upload hook rejects with when it knows why the upload failed. Any error with a
 * `failureKind` (and, for `too-large`, a `maxFileSize` in bytes) says the same, so a host's own
 * error class need not extend this one. A rejection that says nothing reads as `network` when it
 * is a `TypeError` (what `fetch` rejects with when the request never completes) and as `unknown`
 * otherwise.
 */
export class ChatAttachmentUploadError extends Error {
  readonly failureKind: ChatAttachmentFailureKind;
  /** The limit in bytes, for `too-large`. */
  readonly maxFileSize: number | undefined;

  constructor(
    kind: ChatAttachmentFailureKind,
    options: {
      readonly message?: string;
      readonly cause?: unknown;
      readonly maxFileSize?: number;
    } = {},
  ) {
    super(options.message ?? `Attachment upload failed: ${kind}`, { cause: options.cause });
    this.name = 'ChatAttachmentUploadError';
    this.failureKind = kind;
    this.maxFileSize = options.maxFileSize;
  }
}

/** The words shown for a failure. */
export type ChatAttachmentErrorFormatter = (failure: ChatAttachmentFailure) => string;

/** Attachment metadata for files (images, code, documents). */
export interface ChatAttachment {
  id: string;
  file: File;
  previewUrl: string;
  kind: AttachmentKind;
  textContent?: string;
  /** Original pasted text restored to the composer when this promoted attachment is removed. */
  restoreText?: string;
  /** Original selection replaced when a promoted paste is restored. */
  restoreRange?: { start: number; end: number };
  status: FileUploadStatus;
  error?: string;
  /**
   * Why an `error` attachment failed, so the composer can word it and say whether trying again can
   * work. A host that sets none reads as `unknown`.
   */
  failureKind?: ChatAttachmentFailureKind;
  /** The limit in bytes a `too-large` attachment is over, when it is known. */
  maxFileSize?: number;
  /**
   * What the composer took when an `unsupported-type` attachment was refused, so the line that
   * says what to attach instead keeps its words when the host changes the limits later.
   */
  acceptedTypes?: readonly string[];
  /** What the host's `uploadAttachment` hook answered, once the attachment is `ready`. */
  reference?: ChatAttachmentReference;
  /** How much of an `uploading` attachment has been sent, from 0 to 1, when the hook reports it. */
  progress?: number;
  /**
   * Whether an `error` attachment offers Retry: its upload failed. A file the composer refused
   * (too large, or a type it does not accept) can only be removed.
   */
  retryable?: boolean;
}
