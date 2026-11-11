import type { AttachmentKind } from './attachment-kind.ts';
import type { ChatAttachment } from './chat-attachment.ts';

/**
 * How many attachment tiles the composer shows before it caps the list: exactly these show, each
 * whole, and the rest wait behind a count under it, so a pile of files never pushes Send off a
 * phone.
 */
export const ATTACHMENT_LIST_CAP = 3;

/** The longest extension kept whole beside a truncated name, dot included. */
const MAXIMUM_EXTENSION_LENGTH = 10;

/**
 * A file name in two parts, so the stem can truncate in the middle of the name while the extension
 * stays whole: `quarterly-report-final.pdf` is `quarterly-report-final` and `.pdf`. A name with no
 * extension, a dotfile such as `.env`, or an extension too long to be one is all stem.
 */
export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > MAXIMUM_EXTENSION_LENGTH) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

const KIND_BADGES: Record<AttachmentKind, string> = {
  image: 'IMG',
  code: 'CODE',
  document: 'DOC',
};

/**
 * The short type badge on a tile: the file's extension in capitals (at most four letters), or a
 * word for its kind when it has none.
 */
export function fileTypeBadge(name: string, kind: AttachmentKind): string {
  const { extension } = splitFileName(name);
  const letters = extension.slice(1).toUpperCase();
  if (letters === '' || letters.length > 4) return KIND_BADGES[kind];
  return letters;
}

/** Whether an attachment blocks Send until it is retried or removed. */
export function needsAttention(attachment: Pick<ChatAttachment, 'status'>): boolean {
  return attachment.status === 'error';
}

/** Whether a failed attachment offers Retry: its upload failed, rather than being refused. */
export function canRetry(attachment: Pick<ChatAttachment, 'status' | 'retryable'>): boolean {
  return attachment.status === 'error' && attachment.retryable === true;
}

/** The count the summary over the tiles starts with: `3 files`. */
export function attachmentCountText(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/** Why Send is off while files need attention, shown under the composer and named by Send. */
export function attachmentBlockingReason(count: number): string {
  return count === 1 ? 'Retry or remove 1 file to send' : `Retry or remove ${count} files to send`;
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
