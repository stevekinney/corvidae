/**
 * Built-in media inspection (COR-794): content sniffing from magic bytes,
 * image dimensions for PNG/GIF/JPEG/WebP, and PDF page counts. Everything here is
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
const singleByteDecoder = new TextDecoder('latin1');

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

/** ISO base media (`ftyp`) major brands that name something other than generic MP4 video. */
const FTYP_BRANDS: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heix: 'image/heic',
  heim: 'image/heic',
  heis: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  mif1: 'image/heic',
  msf1: 'image/heic',
  'M4A ': 'audio/mp4',
  'M4B ': 'audio/mp4',
  'M4P ': 'audio/mp4',
  'qt  ': 'video/quicktime',
};

function ftypMediaType(bytes: Uint8Array): string {
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return FTYP_BRANDS[brand] ?? 'video/mp4';
}

/**
 * The media type the bytes themselves declare, or `undefined` when nothing
 * recognizable is found. Valid UTF-8 without NUL characters is `text/plain`.
 * An ISO base media file is refined by its `ftyp` major brand.
 */
export function detectMediaType(bytes: Uint8Array): string | undefined {
  for (const entry of SIGNATURES) {
    if (!startsWith(bytes, entry.signature, entry.offset ?? 0)) continue;
    if (entry.also && !startsWith(bytes, entry.also.signature, entry.also.offset)) continue;
    return entry.mediaType === 'video/mp4' ? ftypMediaType(bytes) : entry.mediaType;
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
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'image/heif': 'image/heic',
  'application/x-zip-compressed': 'application/zip',
};

function canonical(mediaType: string): string {
  const normalized = normalizeMediaType(mediaType);
  return (Object.hasOwn(ALIASES, normalized) ? ALIASES[normalized] : undefined) ?? normalized;
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

/** Formats that are containers: sniffing sees the container, and these declarations name what it holds. */
function isZipFormat(claim: string): boolean {
  return (
    claim === 'application/epub+zip' ||
    claim.startsWith('application/vnd.openxmlformats-officedocument.') ||
    claim.startsWith('application/vnd.oasis.opendocument.')
  );
}

const AUDIO_VIDEO_FTYP = new Set([
  'video/mp4',
  'audio/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/3gpp2',
]);

/**
 * Whether `claim` names a format carried in the container `detected` found.
 * An audio/video `ftyp` box accepts any audio/video ISO media declaration; an
 * image brand (HEIC, AVIF) accepts only its own image type, so an image
 * claim can never relabel video bytes (or the reverse) to dodge its limits.
 */
function containerCarries(detected: string, claim: string): boolean {
  if (detected === 'application/zip') return isZipFormat(claim);
  if (AUDIO_VIDEO_FTYP.has(detected)) return AUDIO_VIDEO_FTYP.has(claim);
  return false;
}

/**
 * Decides the asset's media type from what the caller declared and what the
 * bytes show, or returns `undefined` when they contradict each other.
 *
 * - Nothing declared: the detected type, or `application/octet-stream`.
 * - Declared and detected agree (after aliasing): the detected type.
 * - Detected `text/plain` and a textual declaration (`text/*`, JSON, XML):
 *   the declared type — sniffing cannot tell those apart.
 * - Detected a container (ZIP, an ISO media `ftyp` box) and a declaration of
 *   a format that container carries (OOXML, ODF, EPUB; MP4 audio,
 *   QuickTime, 3GP): the declared type.
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
  if (containerCarries(detected, claim)) return claim;
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

/** Reads a WebP's canvas size from its `VP8 `, `VP8L`, or `VP8X` chunk. */
function webpDimensions(bytes: Uint8Array): AssetMediaFacts {
  if (bytes.byteLength < 30) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X') {
    const width = 1 + (view.getUint16(24, true) | (bytes[26]! << 16));
    const height = 1 + (view.getUint16(27, true) | (bytes[29]! << 16));
    return { width, height };
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const packed = view.getUint32(21, true);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return {};
}

/**
 * A page-bomb guard, not a PDF parser: the larger of the plaintext
 * `/Type /Page` objects (never `/Pages`) and the largest page-tree `/Count`.
 * A PDF always has at least one page, so finding none — page objects packed
 * into compressed object streams, say — reports the count as unmeasured.
 */
function pdfPageCount(bytes: Uint8Array): AssetMediaFacts {
  // One native decode, not a string built byte by byte: a PDF may be as large
  // as `maxAssetBytes`, and per-byte concatenation over 100 MiB holds the event
  // loop and allocates a node per byte. WHATWG `latin1` is windows-1252, which
  // differs from a byte-per-code-point mapping only in 0x80–0x9F, and none of
  // those characters is whitespace, an ASCII letter, or a digit, so the
  // patterns below match exactly as they would over the raw bytes.
  const text = singleByteDecoder.decode(bytes);
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  let pageCount = pages;
  for (const match of text.matchAll(/\/Count\s+(\d+)/g)) {
    pageCount = Math.max(pageCount, Number(match[1]));
  }
  return pageCount > 0 ? { pageCount } : {};
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
    case 'image/webp':
      return webpDimensions(bytes);
    case 'application/pdf':
      return pdfPageCount(bytes);
    default:
      return {};
  }
}
