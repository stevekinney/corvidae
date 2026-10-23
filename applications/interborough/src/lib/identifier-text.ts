/**
 * Splits a line of prose so the identifiers in it can be set in monospace: the kebab-case names of
 * agents and tools (`request-human-input`, `issue-refund`) and ids such as `order-1001`. A word with
 * no hyphen between letters or digits is prose, and so is a hyphen at either edge of a word.
 */
const IDENTIFIER = /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/gi;

export type TextSegment = { readonly text: string; readonly identifier: boolean };

export function segmentIdentifiers(text: string): readonly TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(IDENTIFIER)) {
    const start = match.index;
    if (start > last) segments.push({ text: text.slice(last, start), identifier: false });
    segments.push({ text: match[0], identifier: true });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), identifier: false });
  return segments;
}
