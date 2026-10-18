/**
 * What a media type says about a part (COR-716): whether it is text a provider
 * reads, whether it fits the part's modality, and whether base64 bytes decode.
 * One table for the schema, admission, the adapters, and every surface that
 * inspects content, so they cannot disagree about what a part is. Every
 * comparison starts from {@link baseMimeType}, so a parameter such as
 * `;version=1.7` or `; charset=utf-8`, or an upper-cased type, never changes the
 * answer.
 */
import type { Modality } from './multi-modal';

/** The media type without parameters, lower-cased: `Text/Plain; charset=utf-8` is `text/plain`. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The document types besides `text/*`, each saying whether its bytes are text a
 * provider reads as characters. `application/rtf` is text: RTF is 7-bit ASCII
 * markup, so a surface that inspects or redacts text can read it. The office
 * containers and PDF are binary. Both `isTextualMimeType` and the modality
 * check read this one table, so the two cannot disagree.
 */
const DOCUMENT_MIME_TYPES: ReadonlyMap<string, { readonly textual: boolean }> = new Map([
  ['application/pdf', { textual: false }],
  ['application/rtf', { textual: true }],
  ['application/json', { textual: true }],
  ['application/xml', { textual: true }],
  ['application/msword', { textual: false }],
  ['application/vnd.ms-excel', { textual: false }],
  ['application/vnd.ms-powerpoint', { textual: false }],
]);

/** Whether the bytes of this media type are text a provider reads as characters. */
export function isTextualMimeType(mimeType: string | undefined): boolean {
  if (mimeType === undefined) return false;
  const base = baseMimeType(mimeType);
  return (
    base.startsWith('text/') ||
    DOCUMENT_MIME_TYPES.get(base)?.textual === true ||
    base.endsWith('+json') ||
    base.endsWith('+xml')
  );
}

/** Whether a base media type is a document type: PDF, text, structured text, or an office container. */
export function isDocumentMimeType(base: string): boolean {
  return (
    DOCUMENT_MIME_TYPES.has(base) ||
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

/** What canonical base64 requires; named in every refusal so the caller knows what to fix. */
export const BASE64_REQUIREMENT =
  'base64 must use the standard alphabet and be padded to a multiple of four characters';

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

/** A data URL split into its header tokens and payload. */
export interface SplitDataUrl {
  /** The header between `data:` and the comma, exactly as written. */
  readonly header: string;
  /** The media type, lower-cased, or `undefined` when the header names none. */
  readonly mimeType: string | undefined;
  /** Whether the header carries the `base64` flag. */
  readonly isBase64: boolean;
  /** Everything after the first comma, exactly as written. */
  readonly payload: string;
}

/**
 * The one place a data URL is split (RFC 2397). The scheme, the media type, and the
 * `base64` flag are all case-insensitive, so `DATA:`, `TEXT/PLAIN`, and `;BASE64` read
 * the same as their lower-case forms. Validation, the exporters, the body reader, and
 * the PII rewrite all go through it, so none can read a header differently from another
 * (a `;BASE64` payload read as percent-encoded text would send the bytes of the base64
 * string itself). `undefined` when `url` is not a data URL or has no comma.
 */
export function splitDataUrl(url: string): SplitDataUrl | undefined {
  if (url.slice(0, 'data:'.length).toLowerCase() !== 'data:') return undefined;
  const comma = url.indexOf(',');
  if (comma === -1) return undefined;
  const header = url.slice('data:'.length, comma);
  const [first = '', ...rest] = header.split(';');
  // A first token without a slash is a parameter (`data:;base64,...`), not a media type.
  const firstIsMediaType = first.includes('/');
  const parameters = firstIsMediaType ? rest : [first, ...rest];
  return {
    header,
    mimeType: firstIsMediaType ? first.trim().toLowerCase() : undefined,
    isBase64: parameters.some((parameter) => parameter.trim().toLowerCase() === 'base64'),
    payload: url.slice(comma + 1),
  };
}

/**
 * Why a data URL's payload cannot be decoded, or `undefined` when it decodes:
 * valid base64 after `;base64` (in any case), a valid URI component otherwise.
 */
export function dataUrlDefect(url: string): string | undefined {
  const split = splitDataUrl(url);
  if (split === undefined) return 'a data URL needs a comma before its payload';
  if (split.payload === '') return 'a data URL needs a payload';
  if (split.isBase64) {
    return isDecodableBase64(split.payload) ? undefined : `its ${BASE64_REQUIREMENT}`;
  }
  try {
    decodeURIComponent(split.payload);
    return undefined;
  } catch {
    return 'its payload is not a valid URI component';
  }
}

/** A data URL whose payload decodes; see {@link dataUrlDefect}. */
export function isWellFormedDataUrl(url: string): boolean {
  return dataUrlDefect(url) === undefined;
}
