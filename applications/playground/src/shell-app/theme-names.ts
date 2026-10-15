/** Theme names: 1–80 trimmed characters, unique case-insensitively across the library. */

export const MAX_THEME_NAME_LENGTH = 80;

export type NameProblem = 'name-empty' | 'name-too-long' | 'name-conflict';

const characters = (text: string): string[] => Array.from(text);
const fold = (name: string): string => name.normalize('NFC').toLowerCase();

/** Validate `raw` against `taken` (names of every other theme, trash included). */
export function checkThemeName(
  raw: string,
  taken: readonly string[],
): { ok: true; name: string } | { ok: false; reason: NameProblem } {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, reason: 'name-empty' };
  if (characters(name).length > MAX_THEME_NAME_LENGTH)
    return { ok: false, reason: 'name-too-long' };
  const folded = fold(name);
  if (taken.some((existing) => fold(existing) === folded)) {
    return { ok: false, reason: 'name-conflict' };
  }
  return { ok: true, name };
}

/** `stem` or, when taken, `stem 2`, `stem 3`…, with the stem trimmed to stay within 80. */
export function uniqueThemeName(stem: string, taken: readonly string[]): string {
  const folded = new Set(taken.map(fold));
  const trimmedStem = stem.trim();
  const bounded = characters(trimmedStem).slice(0, MAX_THEME_NAME_LENGTH).join('').trimEnd();
  if (!folded.has(fold(bounded))) return bounded;
  for (let suffix = 2; ; suffix += 1) {
    const tail = ` ${suffix}`;
    const room = MAX_THEME_NAME_LENGTH - tail.length;
    const candidate = `${characters(trimmedStem).slice(0, room).join('').trimEnd()}${tail}`;
    if (!folded.has(fold(candidate))) return candidate;
  }
}
