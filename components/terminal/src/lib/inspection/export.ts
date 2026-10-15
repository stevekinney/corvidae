import type { TerminalProjection } from '../components/terminal/terminal-projection.ts';
import { EXPORT_BYTE_LIMIT, EXPORT_FILE_NAME, EXPORT_LINE_LIMIT } from './inspection-types.ts';

/**
 * A plain-text export of retained output. The text is the projection's own: soft wraps joined,
 * hard line breaks as LF, no markup and no escape codes. When it is cut, the newest output is kept,
 * from a whole line (or, for one line over the limit, a whole code point), and nothing is added to
 * the content to say so: the result says it, and the caller shows that before anything is saved.
 */
export type TextExport = {
  /** The text to save: UTF-8 without a byte order mark when encoded, LF line endings. */
  text: string;
  /** The retained output was longer than what `text` holds. */
  truncated: boolean;
  /** The UTF-8 bytes in `text`. */
  exportedBytes: number;
  /**
   * The UTF-8 bytes of retained output that were read. It stops counting at the read ceiling, so
   * it is a lower bound when the retained output was larger than that.
   */
  retainedBytes: number;
};

export type ExportLimits = {
  maximumBytes: number;
  maximumLines: number;
};

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maximumBytes: EXPORT_BYTE_LIMIT,
  maximumLines: EXPORT_LINE_LIMIT,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The newest `maximumLines` lines of `text`: everything after the line feed that precedes them. */
function limitLines(text: string, maximumLines: number): string {
  let boundary = text.length;
  for (let line = 0; line < maximumLines; line += 1) {
    // `lastIndexOf` treats a negative start as 0, so at the first character it would find itself.
    if (boundary <= 0) return text;
    boundary = text.lastIndexOf('\n', boundary - 1);
    if (boundary < 0) return text;
  }
  return text.slice(boundary + 1);
}

/**
 * The newest part of `text` within `maximumBytes`, starting at a whole line when the window holds a
 * line break and otherwise, for one line larger than the limit, at a whole code point.
 */
function limitBytes(text: string, maximumBytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= maximumBytes) return text;
  let start = encoded.length - maximumBytes;
  // A UTF-8 continuation byte is 10xxxxxx; step forward to the start of the next code point.
  while (start < encoded.length && (encoded[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  const window = decoder.decode(encoded.subarray(start));
  // The window began somewhere inside a line: drop that partial line so the file starts whole.
  const lineBreak = encoded[start - 1] === 0x0a ? -1 : window.indexOf('\n');
  return lineBreak >= 0 && lineBreak < window.length - 1 ? window.slice(lineBreak + 1) : window;
}

/**
 * The export of `projection` within `limits`, keeping the newest output. A leading U+FEFF is
 * dropped: it would read as a byte order mark, and the file is UTF-8 without one.
 */
export function buildTextExport(
  projection: TerminalProjection,
  limits: ExportLimits = DEFAULT_EXPORT_LIMITS,
): TextExport {
  let start = 0;
  while (projection.text.charCodeAt(start) === 0xfeff) start += 1;
  const withoutMark = start === 0 ? projection.text : projection.text.slice(start);
  let text = limitBytes(limitLines(withoutMark, limits.maximumLines), limits.maximumBytes);
  while (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return {
    text,
    truncated: projection.truncated || text.length < withoutMark.length,
    exportedBytes: encoder.encode(text).length,
    retainedBytes: projection.bytes,
  };
}

/** Saves text as a file. Replaceable, so a test can observe a save without a browser. */
export const textSaver: { save: (text: string, fileName?: string) => void } = {
  save: saveTextAsFile,
};

/** Offers `text` to the browser as a UTF-8 download, then releases the temporary address. */
export function saveTextAsFile(text: string, fileName: string = EXPORT_FILE_NAME): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
