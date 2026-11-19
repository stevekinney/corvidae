/**
 * A reason set after a comma, inside a line ("Assistant, took 6 s, the answer doesn't mention the
 * fix"): its first letter is lower-cased when its first word is a plain capitalised word, one
 * capital and then lower-case letters, other than "I". A proper noun or an acronym with a capital
 * inside it ("GitHub", "HTTP") keeps its case, as does a reason that starts with anything else.
 * Used by the goal page's attempt rows and the Runs list's line two.
 */
export function reasonClause(reason: string): string {
  const trimmed = reason.trim();
  const first = /^\p{L}+/u.exec(trimmed)?.[0];
  if (first === undefined || first === 'I') return trimmed;
  if (!/^\p{Lu}\p{Ll}+$/u.test(first)) return trimmed;
  return `${trimmed.charAt(0).toLocaleLowerCase()}${trimmed.slice(1)}`;
}
