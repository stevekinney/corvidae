/**
 * The text a provider reads from a media part's own bytes (COR-716).
 *
 * A provider receives inline text, and text carried in a data URL, as
 * characters, so a surface that inspects or transforms content must see it as
 * it sees a text part. A resolved asset's body counts when a resolution
 * exists. This is the one place that decides what such text is, and how it is
 * put back, so the input guardrail, the PII plugin, and any surface added later
 * read the same text.
 */
import { encodeUtf8Base64, parseDataUrl, type ResolvedMediaSource } from './adapters/media';
import { isTextualMimeType } from './media-types';
import type { ContentSource, MediaContent } from './multi-modal';

/** A part's text body, and how to put a replacement back in the form it was stored in. */
export interface MediaBody {
  readonly text: string;
  /**
   * The part with its body replaced by `text`, in the encoding the body was
   * stored in. `undefined` when the body came from a resolution: there is no
   * stored body to rewrite.
   */
  readonly withText: ((text: string) => MediaContent) | undefined;
}

export type MediaBodyReading =
  /** The part carries no text body: binary bytes, or a source that names bytes elsewhere. */
  | { readonly status: 'none' }
  | { readonly status: 'text'; readonly body: MediaBody }
  /** The part is text a provider would read, but its bytes are not valid UTF-8 text. */
  | { readonly status: 'undecodable'; readonly reason: string };

const NONE: MediaBodyReading = { status: 'none' };

function decodeUtf8Base64(data: string): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(data), (character) => character.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
}

/**
 * Reads the text body a provider would read from `part`, or says it has none.
 *
 * - Inline UTF-8 data is always text.
 * - Inline base64 and data URLs are text when their media type is textual
 *   (the resolution's type wins over the part's, and a data URL's own header
 *   over both); binary media types carry no body.
 * - A text body that does not decode as UTF-8 is `undecodable`, which callers
 *   refuse rather than skip.
 * - With a `resolved` source, the resolved bytes are what the provider reads.
 */
export function readMediaBody(
  part: MediaContent,
  resolved?: ResolvedMediaSource,
): MediaBodyReading {
  const source: ContentSource = resolved?.source ?? part.source;
  const declared = resolved?.mimeType ?? part.mimeType;
  const rewritable = resolved === undefined;

  if (source.kind === 'inline') {
    if (source.encoding === 'utf8') {
      return textBody(
        source.data,
        rewritable
          ? (text) => ({ ...part, source: { kind: 'inline', data: text, encoding: 'utf8' } })
          : undefined,
      );
    }
    if (!isTextualMimeType(declared)) return NONE;
    const text = decodeUtf8Base64(source.data);
    if (text === undefined) return { status: 'undecodable', reason: 'inline base64 is not UTF-8' };
    return textBody(
      text,
      rewritable
        ? (next) => ({
            ...part,
            source: { kind: 'inline', data: encodeUtf8Base64(next), encoding: 'base64' },
          })
        : undefined,
    );
  }

  if (source.kind === 'data-url') {
    const parsed = parseDataUrl(source.url);
    const mimeType = parsed?.mimeType ?? declared;
    if (!isTextualMimeType(mimeType)) return NONE;
    if (parsed === undefined) {
      return { status: 'undecodable', reason: 'the data URL does not parse' };
    }
    const text = decodeUtf8Base64(parsed.data);
    if (text === undefined) {
      return { status: 'undecodable', reason: 'the data URL body is not UTF-8' };
    }
    return textBody(
      text,
      rewritable
        ? (next) => ({
            ...part,
            source: { kind: 'data-url', url: rebuildDataUrl(source.url, next) },
          })
        : undefined,
    );
  }

  return NONE;
}

function textBody(
  text: string,
  withText: ((text: string) => MediaContent) | undefined,
): MediaBodyReading {
  return text === '' ? NONE : { status: 'text', body: { text, withText } };
}

/** Rebuilds a data URL around `text`, keeping the header and the encoding it declared. */
function rebuildDataUrl(url: string, text: string): string {
  const comma = url.indexOf(',');
  const header = url.slice(0, comma);
  const isBase64 = header.split(';').includes('base64');
  return `${header},${isBase64 ? encodeUtf8Base64(text) : encodeURIComponent(text)}`;
}
