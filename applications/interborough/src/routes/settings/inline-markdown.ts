/**
 * The inline Markdown a setting's description uses: `code` spans, which name a key, a value or a
 * method. The Bureau writes nothing else in a description, so this reads nothing else; text with no
 * backtick is one plain segment.
 */

/** One run of a description: plain text, or the code between two backticks. */
export type InlineSegment = { readonly kind: 'text' | 'code'; readonly text: string };

/** The runs of `text`, in order. An unmatched backtick is plain text. */
export function inlineSegments(text: string): readonly InlineSegment[] {
  const segments: InlineSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const open = rest.indexOf('`');
    const close = open === -1 ? -1 : rest.indexOf('`', open + 1);
    if (open === -1 || close === -1) {
      segments.push({ kind: 'text', text: rest });
      break;
    }
    if (open > 0) segments.push({ kind: 'text', text: rest.slice(0, open) });
    if (close > open + 1) segments.push({ kind: 'code', text: rest.slice(open + 1, close) });
    rest = rest.slice(close + 1);
  }
  return segments;
}
