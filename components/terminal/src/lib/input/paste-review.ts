import {
  DEFAULT_MAXIMUM_PASTE_BYTES,
  MAXIMUM_PASTE_BYTES,
  MINIMUM_PASTE_BYTES,
} from './input-types.ts';

/**
 * What a paste review needs to know, and how it is shown. A paste is data, not a command boundary:
 * nothing here rewrites it. The review exists so the reader sees the newlines and control bytes
 * that would otherwise run or reconfigure a shell the moment they landed.
 */

/** The terminator of a bracketed paste. Pasted text that carries it ends the bracket early. */
const PASTE_TERMINATOR = '\u001b[201~';

export type PasteReview =
  | {
      kind: 'confirm';
      /** The clipboard text, exactly as read. Accepting sends this and nothing else. */
      text: string;
      /** The same text with newlines and controls made visible, for display only. */
      visibleText: string;
      /** UTF-8 bytes of {@link PasteReview.text}. */
      bytes: number;
      /** Lines in the text; a trailing newline does not add an empty one. */
      lines: number;
      /** The text ends with a line break, which would run its last line. */
      endsWithNewline: boolean;
      /** Control characters other than line breaks: C0, DEL and C1. */
      controlCount: number;
      /** The text contains the bracketed-paste terminator. */
      containsPasteTerminator: boolean;
      maximumBytes: number;
    }
  | {
      /** The paste is over the limit, so it is not offered. Nothing is kept. */
      kind: 'rejected';
      bytes: number;
      maximumBytes: number;
    };

export type PasteAnalysis = {
  bytes: number;
  lines: number;
  hasNewline: boolean;
  endsWithNewline: boolean;
  controlCount: number;
  containsPasteTerminator: boolean;
  /** Multiline or control-bearing: worth showing before it is sent. */
  needsReview: boolean;
  tooLarge: boolean;
};

const encoder = new TextEncoder();

function isLineBreak(code: number): boolean {
  return code === 0x0a || code === 0x0d;
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function analyzePaste(text: string, maximumBytes: number): PasteAnalysis {
  const bytes = encoder.encode(text).length;
  let breaks = 0;
  let controlCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isLineBreak(code)) {
      // CR LF is one break.
      if (!(code === 0x0d && text.charCodeAt(index + 1) === 0x0a)) breaks += 1;
    } else if (isControl(code)) {
      controlCount += 1;
    }
  }
  const endsWithNewline = text.length > 0 && isLineBreak(text.charCodeAt(text.length - 1));
  const hasNewline = breaks > 0;
  return {
    bytes,
    lines: text.length === 0 ? 0 : breaks + (endsWithNewline ? 0 : 1),
    hasNewline,
    endsWithNewline,
    controlCount,
    containsPasteTerminator: text.includes(PASTE_TERMINATOR),
    needsReview: hasNewline || controlCount > 0,
    tooLarge: bytes > maximumBytes,
  };
}

/**
 * The text with each line break and control shown as its Unicode control picture (`␊`, `␍`, `␛`,
 * `␡`), and each C1 control as its code point. Line breaks keep a real break after the picture so
 * the lines still read as lines; the original text is never altered, only this display copy.
 */
export function renderVisibleControls(text: string): string {
  let shown = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      const crlf = text.charCodeAt(index + 1) === 0x0a;
      shown += crlf ? '␍␊\n' : '␍\n';
      if (crlf) index += 1;
    } else if (code === 0x0a) {
      shown += '␊\n';
    } else if (code < 0x20) {
      shown += String.fromCharCode(0x2400 + code);
    } else if (code === 0x7f) {
      shown += '␡';
    } else if (code >= 0x80 && code <= 0x9f) {
      shown += `⟦U+${code.toString(16).toUpperCase().padStart(4, '0')}⟧`;
    } else {
      shown += text[index];
    }
  }
  return shown;
}

/**
 * The review for `text`: a rejection when it is over the limit, which keeps none of the text, and
 * otherwise everything the reader needs to decide.
 */
export function reviewPaste(text: string, maximumBytes: number): PasteReview {
  const analysis = analyzePaste(text, maximumBytes);
  if (analysis.tooLarge) return { kind: 'rejected', bytes: analysis.bytes, maximumBytes };
  return {
    kind: 'confirm',
    text,
    visibleText: renderVisibleControls(text),
    bytes: analysis.bytes,
    lines: analysis.lines,
    endsWithNewline: analysis.endsWithNewline,
    controlCount: analysis.controlCount,
    containsPasteTerminator: analysis.containsPasteTerminator,
    maximumBytes,
  };
}

/**
 * The paste limit a host asked for. Missing, non-integer, or out-of-range values fail closed to the
 * documented default rather than being clamped or accepted: a limit nobody validated is not one to
 * widen the budget with.
 */
export function resolvePasteLimit(requested: unknown): number {
  return typeof requested === 'number' &&
    Number.isSafeInteger(requested) &&
    requested >= MINIMUM_PASTE_BYTES &&
    requested <= MAXIMUM_PASTE_BYTES
    ? requested
    : DEFAULT_MAXIMUM_PASTE_BYTES;
}
