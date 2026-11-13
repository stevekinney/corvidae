import type { AttachmentKind } from './attachment-kind.ts';
import {
  ChatAttachmentUploadError,
  type ChatAttachment,
  type ChatAttachmentFailureKind,
} from './chat-attachment.ts';

/** The longest extension kept whole beside a truncated name, dot included. */
const MAXIMUM_EXTENSION_LENGTH = 10;

/**
 * A file name in two parts, so the stem can truncate at its end while the extension stays whole:
 * `quarterly-report-final.pdf` is `quarterly-report-final` and `.pdf`. A name with no extension, a
 * dotfile such as `.env`, or an extension too long to be one is all stem.
 */
export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > MAXIMUM_EXTENSION_LENGTH) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/** The glyph a file wears on its chip: what kind of file it is, in the person's words. */
export type AttachmentGlyph =
  'image' | 'document' | 'spreadsheet' | 'archive' | 'audio' | 'video' | 'code' | 'file';

const SPREADSHEET_EXTENSIONS = new Set([
  '.xls',
  '.xlsx',
  '.xlsm',
  '.csv',
  '.tsv',
  '.ods',
  '.numbers',
]);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar']);
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.txt',
  '.md',
  '.pages',
  '.ppt',
  '.pptx',
  '.key',
]);

/**
 * Which glyph a file wears. The media type decides first, then the extension for the types a
 * browser reports as nothing or as a generic `application/octet-stream`; a file that is none of
 * these gets the plain file glyph. `kind` is the composer's own reading and settles an image or a
 * piece of code.
 */
export function attachmentGlyph(
  name: string,
  mediaType: string,
  kind: AttachmentKind,
): AttachmentGlyph {
  const type = mediaType.toLowerCase();
  const extension = splitFileName(name.toLowerCase()).extension;
  if (kind === 'image' || type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (
    SPREADSHEET_EXTENSIONS.has(extension) ||
    type.includes('spreadsheet') ||
    type === 'application/vnd.ms-excel' ||
    type === 'text/csv'
  ) {
    return 'spreadsheet';
  }
  if (
    ARCHIVE_EXTENSIONS.has(extension) ||
    type === 'application/zip' ||
    type === 'application/gzip' ||
    type === 'application/x-tar' ||
    type === 'application/x-7z-compressed'
  ) {
    return 'archive';
  }
  if (kind === 'code') return DOCUMENT_EXTENSIONS.has(extension) ? 'document' : 'code';
  if (
    DOCUMENT_EXTENSIONS.has(extension) ||
    type === 'application/pdf' ||
    type.includes('wordprocessing') ||
    type === 'application/msword'
  ) {
    return 'document';
  }
  return 'file';
}

/** Whether an attachment blocks Send until it is retried or removed. */
export function needsAttention(attachment: Pick<ChatAttachment, 'status'>): boolean {
  return attachment.status === 'error';
}

/** Whether a failed attachment offers Retry: its upload failed, rather than being refused. */
export function canRetry(attachment: Pick<ChatAttachment, 'status' | 'retryable'>): boolean {
  return attachment.status === 'error' && attachment.retryable === true;
}

/** Whether trying again can fix a failure of this kind. */
export function isRetryableFailure(kind: ChatAttachmentFailureKind): boolean {
  return kind === 'network' || kind === 'unknown';
}

/** Why a failed attachment failed: what its host said, or `unknown` when it said nothing. */
export function failureKindOf(
  attachment: Pick<ChatAttachment, 'failureKind'>,
): ChatAttachmentFailureKind {
  return attachment.failureKind ?? 'unknown';
}

/**
 * What a rejected upload was: the kind an upload hook named with a `ChatAttachmentUploadError`; a
 * `TypeError`, which is what `fetch` rejects with when the request never completes, reads as
 * `network`; anything else is `unknown`.
 */
export function classifyUploadFailure(error: unknown): {
  kind: ChatAttachmentFailureKind;
  maxFileSize?: number;
} {
  if (error instanceof ChatAttachmentUploadError) {
    return error.maxFileSize === undefined
      ? { kind: error.kind }
      : { kind: error.kind, maxFileSize: error.maxFileSize };
  }
  if (error instanceof TypeError) return { kind: 'network' };
  return { kind: 'unknown' };
}

/** The one line under the strip while a failure blocks Send, before it is put in words. */
export type AttachmentFailureLine =
  | {
      readonly type: 'one';
      readonly attachment: ChatAttachment;
      readonly kind: ChatAttachmentFailureKind;
      /** What its action does: a file that can be tried again is retried, any other is removed. */
      readonly action: 'retry' | 'remove';
    }
  | { readonly type: 'many'; readonly count: number; readonly action: 'retry-all' | 'remove-all' };

/**
 * What the line under the strip says. One failed file is named, with the action that fits it. Several
 * say how many failed and offer to retry them all, or to remove them all when none can be retried.
 * When the person has picked one of several (`pickedId`), the line is about that file alone.
 */
export function attachmentFailureLine(
  attachments: readonly ChatAttachment[],
  pickedId?: string,
): AttachmentFailureLine | undefined {
  const failed = attachments.filter(needsAttention);
  if (failed.length === 0) return undefined;
  const picked = failed.length === 1 ? failed[0] : failed.find((entry) => entry.id === pickedId);
  if (picked !== undefined) {
    return {
      type: 'one',
      attachment: picked,
      kind: failureKindOf(picked),
      action: canRetry(picked) ? 'retry' : 'remove',
    };
  }
  return {
    type: 'many',
    count: failed.length,
    action: failed.some(canRetry) ? 'retry-all' : 'remove-all',
  };
}

/** An upload's progress as a whole percentage between 0 and 100, or `undefined` when unknown. */
export function uploadPercent(progress: number | undefined): number | undefined {
  if (progress === undefined || !Number.isFinite(progress)) return undefined;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/**
 * The kinds of file an accept list takes, in the person's words: `image/*`, `application/pdf` and
 * `text/plain` read "an image, a PDF or a text file". A type with no common name reads as its
 * subtype in capitals ("a JSON file"), and an extension as itself (".csv" reads "a CSV file").
 */
export function acceptedKindsText(acceptedTypes: readonly string[]): string {
  const kinds: string[] = [];
  for (const type of acceptedTypes) {
    const kind = acceptedKind(type.trim().toLowerCase());
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind);
  }
  if (kinds.length <= 1) return kinds[0] ?? 'another kind of file';
  return `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}`;
}

const NAMED_TYPES: Readonly<Record<string, string>> = {
  'image/*': 'an image',
  'audio/*': 'an audio file',
  'video/*': 'a video',
  'text/*': 'a text file',
  'text/plain': 'a text file',
  'text/markdown': 'a Markdown file',
  'text/csv': 'a CSV file',
  'application/pdf': 'a PDF',
  'application/json': 'a JSON file',
};

function acceptedKind(type: string): string | undefined {
  if (type === '') return undefined;
  if (Object.hasOwn(NAMED_TYPES, type)) return NAMED_TYPES[type];
  if (type.startsWith('.')) return `a ${type.slice(1).toUpperCase()} file`;
  const [major, minor] = type.split('/');
  if (major === 'image') return 'an image';
  if (major === 'audio') return 'an audio file';
  if (major === 'video') return 'a video';
  if (minor === undefined || minor === '' || minor === '*') return undefined;
  const name = minor.replace(/^(?:x-|vnd\.)/u, '').split(/[.+]/u)[0] ?? minor;
  return `a ${name.toUpperCase()} file`;
}

/** Why a file the composer does not take was refused, and what it does take. */
export function typeNotAcceptedText(acceptedTypes: readonly string[]): string {
  return `This file type can’t be attached. Attach ${acceptedKindsText(acceptedTypes)}.`;
}
