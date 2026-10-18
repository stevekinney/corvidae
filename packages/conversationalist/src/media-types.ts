/**
 * What a media type says about a part (COR-716): whether it is text a provider
 * reads, whether it fits the part's modality, and whether base64 bytes decode.
 * One table for the schema, admission, and every surface that inspects content,
 * so they cannot disagree about what a part is.
 */
import type { Modality } from './multi-modal';

/** The media type without parameters, lower-cased: `Text/Plain; charset=utf-8` is `text/plain`. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/** Whether the bytes of this media type are text a provider reads as characters. */
export function isTextualMimeType(mimeType: string | undefined): boolean {
  if (mimeType === undefined) return false;
  const base = baseMimeType(mimeType);
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base.endsWith('+json') ||
    base.endsWith('+xml')
  );
}

/**
 * The document types besides `application/pdf` and `text/*`: structured text
 * and the office formats the catalog's `document` family stands for.
 */
const DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/rtf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

function isDocumentMimeType(base: string): boolean {
  return (
    DOCUMENT_MIME_TYPES.has(base) ||
    base.startsWith('text/') ||
    base.startsWith('application/vnd.openxmlformats-officedocument.') ||
    base.startsWith('application/vnd.oasis.opendocument.') ||
    isTextualMimeType(base)
  );
}

/**
 * Whether a media type fits the modality of the part that declares it. An
 * image takes `image/*`, audio `audio/*`, video `video/*`; a document takes
 * `application/pdf`, `text/*`, and the structured-text and office types; a
 * `file` takes any type.
 */
export function mimeTypeFitsModality(
  modality: Exclude<Modality, 'text'>,
  mimeType: string,
): boolean {
  const base = baseMimeType(mimeType);
  switch (modality) {
    case 'image':
      return base.startsWith('image/');
    case 'audio':
      return base.startsWith('audio/');
    case 'video':
      return base.startsWith('video/');
    case 'document':
      return isDocumentMimeType(base);
    case 'file':
      return true;
  }
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Whether `data` is canonical base64 that decodes: the standard alphabet, padded
 * to a multiple of four, with padding only at the end.
 */
export function isDecodableBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
