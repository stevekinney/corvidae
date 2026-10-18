/**
 * Pure rules for quoted excerpts: how a selection becomes a quote, how a quote
 * previews in its chip, and how quotes and typed text combine into the
 * Markdown that is sent.
 */

/** The most quotes a reply can carry. */
export const MAX_QUOTES = 10;

/** The most characters one quote keeps, ellipsis included. */
export const MAX_QUOTE_LENGTH = 4_000;

/** How many characters of a quote its chip shows. */
export const QUOTE_PREVIEW_LENGTH = 80;

const ELLIPSIS = '…';

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/** `text` cut to at most `limit` UTF-16 units, without splitting a surrogate pair. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return text.slice(0, end);
}

/**
 * The text a quote keeps from a selection: surrounding whitespace removed, and
 * anything beyond {@link MAX_QUOTE_LENGTH} cut to one character short of it plus
 * an ellipsis. Returns an empty string when nothing but whitespace was selected.
 */
export function normalizeQuoteText(selected: string): string {
  const text = selected.trim();
  if (text.length <= MAX_QUOTE_LENGTH) return text;
  return `${cut(text, MAX_QUOTE_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** The first {@link QUOTE_PREVIEW_LENGTH} characters of a quote on one line, with an ellipsis if cut. */
export function previewQuoteText(text: string): string {
  const kept = cut(text, QUOTE_PREVIEW_LENGTH);
  const preview = kept.replace(/\s+/g, ' ');
  return kept.length < text.length ? `${preview}${ELLIPSIS}` : preview;
}

/**
 * The message content for a reply: each quote as a Markdown block quote (every
 * line prefixed with `> `), quotes separated by one blank line, then one blank
 * line and the typed text. With no quotes the typed text is returned as is.
 */
export function composeQuotedContent(quotes: readonly string[], typed: string): string {
  if (quotes.length === 0) return typed;
  const blocks = quotes.map((quote) =>
    quote
      .split(/\r\n|\r|\n/)
      .map((line) => `> ${line}`)
      .join('\n'),
  );
  return `${blocks.join('\n\n')}\n\n${typed}`;
}
