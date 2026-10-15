import type { TerminalProjection } from '../components/terminal/terminal-projection.ts';
import { EXPORT_BYTE_LIMIT, EXPORT_FILE_NAME, EXPORT_LINE_LIMIT } from './inspection-types.ts';

/**
 * A plain-text export of retained output. The text is the projection's own: soft wraps joined,
 * hard line breaks as LF, no markup and no escape codes. When it is cut, it is cut at a whole line
 * and then at a whole code point, and nothing is added to the content to say so: the result says
 * it, and the caller shows that before anything is saved.
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

/** The longest prefix of `text` with at most `maximumLines` lines. */
function limitLines(text: string, maximumLines: number): string {
  let end = -1;
  for (let line = 0; line < maximumLines; line += 1) {
    end = text.indexOf('\n', end + 1);
    if (end < 0) return text;
  }
  return text.slice(0, end);
}

/** The longest whole-code-point prefix of `text` that encodes to at most `maximumBytes`. */
function limitBytes(text: string, maximumBytes: number): string {
  // A code unit encodes to at least one byte, so a longer prefix cannot fit.
  const clipped = text.length > maximumBytes ? text.slice(0, maximumBytes) : text;
  const encoded = encoder.encode(clipped);
  if (encoded.length <= maximumBytes) return clipped;
  let cut = maximumBytes;
  // A UTF-8 continuation byte is 10xxxxxx; step back to the start of its code point.
  while (cut > 0 && (encoded[cut]! & 0b1100_0000) === 0b1000_0000) cut -= 1;
  return decoder.decode(encoded.subarray(0, cut));
}

/**
 * The export of `projection` within `limits`. A leading U+FEFF is dropped: it would read as a byte
 * order mark, and the file is UTF-8 without one.
 */
export function buildTextExport(
  projection: TerminalProjection,
  limits: ExportLimits = DEFAULT_EXPORT_LIMITS,
): TextExport {
  let start = 0;
  while (projection.text.charCodeAt(start) === 0xfeff) start += 1;
  const withoutMark = start === 0 ? projection.text : projection.text.slice(start);
  const lined = limitLines(withoutMark, limits.maximumLines);
  const text = limitBytes(lined, limits.maximumBytes);
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
