/**
 * Splits a line of prose so the identifiers in it can be set in monospace. What is an identifier is
 * decided by where the line comes from, never by how a word looks: the caller names the agent, the
 * tool or the run id its line is about, and every whole-word occurrence of one is an identifier,
 * whether or not it has a hyphen (`echo`, `assistant`, `request-human-input`). A word that merely
 * contains one (`echoes`) is prose.
 */
export type TextSegment = { readonly text: string; readonly identifier: boolean };

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function segmentIdentifiers(
  text: string,
  identifiers: readonly string[],
): readonly TextSegment[] {
  // The longest first, so a name that contains another (`echo-loud` and `echo`) is matched whole.
  const names = [...new Set(identifiers.filter((name) => name !== ''))].sort(
    (left, right) => right.length - left.length,
  );
  if (names.length === 0) return text === '' ? [] : [{ text, identifier: false }];
  const pattern = new RegExp(
    `(?<![\\w-])(?:${names.map(escapeForPattern).join('|')})(?![\\w-])`,
    'g',
  );
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > last) segments.push({ text: text.slice(last, start), identifier: false });
    segments.push({ text: match[0], identifier: true });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), identifier: false });
  return segments;
}
