/**
 * Acronyms `humanizeIdentifier` writes in their canonical spelling instead of
 * title-casing them, in the order the copy guidance lists them. A copy lint
 * reads the same list, so a lowercase acronym in UI copy fails it.
 */
export const IDENTIFIER_ACRONYMS = [
  'API',
  'ID',
  'IDs',
  'URL',
  'URLs',
  'URI',
  'UUID',
  'JSON',
  'YAML',
  'HTML',
  'CSS',
  'HTTP',
  'HTTPS',
  'SSE',
  'MCP',
  'CLI',
  'SQL',
  'S3',
  'OAuth',
  'TTL',
  'CPU',
  'GPU',
  'UI',
  'UX',
  'LLM',
  'AI',
  'PR',
  'JWT',
  'TLS',
  'SSH',
  'UTC',
  'AG-UI',
  'A2A',
  'SKU',
] as const;

/** Options for {@link humanizeIdentifier}. */
export type HumanizeIdentifierOptions = {
  /**
   * How the words are cased. `'title'` capitalizes every word (`wrong_item`
   * reads "Wrong Item"); `'sentence'` capitalizes only the first word of each
   * segment (`wrong_item` reads "Wrong item", `timeZone` "Time zone"). Acronyms
   * keep their canonical spelling in both.
   * @default "title"
   */
  casing?: 'title' | 'sentence';
  /**
   * The heading the label appears under. A leading path segment, or leading
   * words, that read the same as the heading are dropped, so `retention.audit`
   * under "Retention" reads "Audit". The prefix is never dropped when nothing
   * would be left.
   */
  under?: string;
};

const PATH_SEPARATOR = ' ▶ ';

const canonicalAcronyms = new Map<string, string>(
  IDENTIFIER_ACRONYMS.map((acronym) => [acronym.toLowerCase(), acronym]),
);

/** Mixed-case acronyms, matched whole so the camelCase split does not cut them apart. */
const mixedCaseAcronyms = IDENTIFIER_ACRONYMS.filter(
  (acronym) => /[a-z]/.test(acronym) && !acronym.includes('-'),
);

/**
 * One word of an identifier chunk: a mixed-case acronym, an upper-case run
 * that a following capitalized word ends (`API` in `APIKey`), a capitalized
 * word, or a lower-case word. Digits stay with the letters before them.
 */
const WORD = new RegExp(
  [
    `(?:${mixedCaseAcronyms.join('|')})(?![a-z])`,
    '[A-Z0-9]+(?![a-z])',
    '[A-Z][a-z0-9]*',
    '[a-z0-9]+',
  ].join('|'),
  'g',
);

function formatWord(word: string, capitalize: boolean): string {
  const acronym = canonicalAcronyms.get(word.toLowerCase());
  if (acronym !== undefined) return acronym;
  return capitalize
    ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    : word.toLowerCase();
}

/** Splits one path segment on `_ - /` and whitespace and at camelCase boundaries. */
function segmentWords(segment: string, casing: 'title' | 'sentence'): string[] {
  const parts = segment.split(/([_\-/\s]+)/);
  const words: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const chunk = parts[index] ?? '';
    const next = parts[index + 2];
    // A hyphenated acronym (AG-UI) spans two chunks joined by a single hyphen.
    if (parts[index + 1] === '-' && next !== undefined) {
      const joined = canonicalAcronyms.get(`${chunk}-${next}`.toLowerCase());
      if (joined !== undefined) {
        words.push(joined);
        index += 2;
        continue;
      }
    }
    for (const match of chunk.matchAll(WORD)) {
      words.push(formatWord(match[0], casing === 'title' || words.length === 0));
    }
  }
  return words;
}

function capitalizeFirst(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((word, index) => word.toLowerCase() === right[index]?.toLowerCase())
  );
}

function dropHeading(
  segments: string[][],
  under: string,
  casing: 'title' | 'sentence',
): string[][] {
  const heading = under.split('.').flatMap((segment) => segmentWords(segment, casing));
  if (heading.length === 0) return segments;
  const [first, ...rest] = segments;
  if (first === undefined) return segments;
  if (rest.length > 0 && sameWords(first, heading)) return rest;
  const prefix = first.slice(0, heading.length);
  if (first.length > heading.length && sameWords(prefix, heading)) {
    return [first.slice(heading.length), ...rest];
  }
  return segments;
}

/**
 * Turns a property key, path, or name into a display label: `orderId` reads
 * "Order ID", `tool-runner` "Tool Runner", `wrong_item` "Wrong Item", and
 * `sessionInput.sessionBacklogLimit` "Session Input ▶ Session Backlog Limit".
 *
 * Words split on `_`, `-`, `/` and whitespace, at camelCase boundaries, and
 * where an upper-case run meets a following word (`APIKey` reads "API Key").
 * Each word is title-cased, except the acronyms in `IDENTIFIER_ACRONYMS`,
 * which keep their canonical spelling. Dotted path segments join with " ▶ ".
 * With `under`, a leading segment or leading words matching that heading are
 * dropped, unless that would drop everything. With `casing: 'sentence'` only
 * the first word of each segment is capitalized: `timeZone` reads "Time zone".
 */
export function humanizeIdentifier(key: string, options: HumanizeIdentifierOptions = {}): string {
  const casing = options.casing ?? 'title';
  let segments = key
    .split('.')
    .map((segment) => segmentWords(segment, casing))
    .filter((words) => words.length > 0);
  if (options.under !== undefined) segments = dropHeading(segments, options.under, casing);
  return segments
    .map((words) => {
      const [first, ...rest] = words;
      // Dropping a heading can leave a lower-case word first in a sentence-cased segment.
      const lead = casing === 'sentence' && first !== undefined ? capitalizeFirst(first) : first;
      return [lead, ...rest].join(' ');
    })
    .join(PATH_SEPARATOR);
}
