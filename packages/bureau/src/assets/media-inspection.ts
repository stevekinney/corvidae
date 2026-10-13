/**
 * Built-in media inspection (COR-794): content sniffing from magic bytes,
 * image dimensions for PNG/GIF/JPEG, and PDF page counts. Everything here is
 * pure and synchronous over the bytes; facts the format cannot reveal cheaply
 * (audio/video duration) come from the injected metadata extractor instead.
 *
 * The mapping from a media type onto conversationalist's `MimeFamily` and
 * `Modality` lives here too, so a descriptor's `modality` is always the
 * value `MediaLimits.modality` is matched against.
 */
import type { MimeFamily, Modality } from 'conversationalist';

import type { AssetMediaFacts } from './types';

const textDecoder = new TextDecoder('utf-8', { fatal: true });

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(text: string): number[] {
  return Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
}

const SIGNATURES: ReadonlyArray<{
  readonly mediaType: string;
  readonly signature: readonly number[];
  readonly offset?: number;
  readonly also?: { readonly signature: readonly number[]; readonly offset: number };
}> = [
  { mediaType: 'image/png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/jpeg', signature: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/gif', signature: ascii('GIF87a') },
  { mediaType: 'image/gif', signature: ascii('GIF89a') },
  {
    mediaType: 'image/webp',
    signature: ascii('RIFF'),
    also: { signature: ascii('WEBP'), offset: 8 },
  },
  {
    mediaType: 'audio/wav',
    signature: ascii('RIFF'),
    also: { signature: ascii('WAVE'), offset: 8 },
  },
  { mediaType: 'application/pdf', signature: ascii('%PDF-') },
  { mediaType: 'audio/mpeg', signature: ascii('ID3') },
  { mediaType: 'audio/ogg', signature: ascii('OggS') },
  { mediaType: 'video/mp4', signature: ascii('ftyp'), offset: 4 },
  { mediaType: 'video/webm', signature: [0x1a, 0x45, 0xdf, 0xa3] },
  { mediaType: 'application/zip', signature: [0x50, 0x4b, 0x03, 0x04] },
];

/**
 * The media type the bytes themselves declare, or `undefined` when nothing
 * recognizable is found. Valid UTF-8 without NUL characters is `text/plain`.
 */
export function detectMediaType(bytes: Uint8Array): string | undefined {
  for (const entry of SIGNATURES) {
    if (!startsWith(bytes, entry.signature, entry.offset ?? 0)) continue;
    if (entry.also && !startsWith(bytes, entry.also.signature, entry.also.offset)) continue;
    return entry.mediaType;
  }
  if (bytes.byteLength === 0 || bytes.includes(0)) return undefined;
  try {
    textDecoder.decode(bytes);
    return 'text/plain';
  } catch {
    return undefined;
  }
}

/** Lower-cases a media type and strips its parameters. */
export function normalizeMediaType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase();
}

const ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
};

function canonical(mediaType: string): string {
  const normalized = normalizeMediaType(mediaType);
  return ALIASES[normalized] ?? normalized;
}

/** Text formats sniffing can only report as `text/plain`. */
function isTextual(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType.endsWith('+json') ||
    mediaType.endsWith('+xml')
  );
}

/**
 * Decides the asset's media type from what the caller declared and what the
 * bytes show, or returns `undefined` when they contradict each other.
 *
 * - Nothing declared: the detected type, or `application/octet-stream`.
 * - Declared and detected agree (after aliasing): the detected type.
 * - Detected `text/plain` and a textual declaration (`text/*`, JSON, XML):
 *   the declared type — sniffing cannot tell those apart.
 * - Nothing detected: only a generic `application/*` declaration is
 *   accepted, since a specific claim (`image/png`) cannot be verified.
 */
export function reconcileMediaType(
  declared: string | undefined,
  detected: string | undefined,
): string | undefined {
  if (declared === undefined) return detected ?? 'application/octet-stream';
  const claim = canonical(declared);
  if (detected === undefined) {
    return mimeFamilyOf(claim) === 'application' ? claim : undefined;
  }
  if (claim === detected) return detected;
  if (detected === 'text/plain' && isTextual(claim)) return claim;
  return undefined;
}

const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/rtf',
  'application/epub+zip',
]);

export function mimeFamilyOf(mediaType: string): MimeFamily {
  const normalized = normalizeMediaType(mediaType);
  if (
    DOCUMENT_TYPES.has(normalized) ||
    normalized.startsWith('application/vnd.openxmlformats-officedocument.') ||
    normalized.startsWith('application/vnd.oasis.opendocument.')
  ) {
    return 'document';
  }
  const prefix = normalized.split('/')[0];
  switch (prefix) {
    case 'text':
    case 'image':
    case 'audio':
    case 'video':
    case 'font':
    case 'model':
      return prefix;
    default:
      return 'application';
  }
}

export function modalityOf(mediaType: string): Modality {
  const family = mimeFamilyOf(mediaType);
  switch (family) {
    case 'text':
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
      return family;
    default:
      return 'file';
  }
}

function pngDimensions(bytes: Uint8Array): AssetMediaFacts {
  if (bytes.byteLength < 24) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifDimensions(bytes: Uint8Array): AssetMediaFacts {
  if (bytes.byteLength < 10) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/** Walks JPEG segments to the first start-of-frame marker. */
function jpegDimensions(bytes: Uint8Array): AssetMediaFacts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return {};
    const marker = bytes[offset + 1]!;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return {};
}

/** Counts `/Type /Page` objects (never `/Pages`) — a page-bomb guard, not a PDF parser. */
function pdfPageCount(bytes: Uint8Array): AssetMediaFacts {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  const matches = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return { pageCount: matches?.length ?? 0 };
}

/** The facts the format itself reveals for `mediaType`. */
export function inspectMediaFacts(bytes: Uint8Array, mediaType: string): AssetMediaFacts {
  switch (mediaType) {
    case 'image/png':
      return pngDimensions(bytes);
    case 'image/gif':
      return gifDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    case 'application/pdf':
      return pdfPageCount(bytes);
    default:
      return {};
  }
}
