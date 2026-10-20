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
 * or the composer goes away. A rejection puts the attachment in the `error` state.
 */
export type ChatAttachmentUpload = (
  file: File,
  context: { readonly signal: AbortSignal },
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
  /** What the host's `uploadAttachment` hook answered, once the attachment is `ready`. */
  reference?: ChatAttachmentReference;
}
