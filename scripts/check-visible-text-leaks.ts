/**
 * Keep file paths, ULIDs and secret references out of Interborough's visible text.
 *
 * Owner standing order (2026-11-19, "I keep telling you"): the interface never shows a host path,
 * an identifier a person cannot read, or a reference to a secret. A person reads "the configuration
 * file", not `/Users/someone/.config/weft/settings.json`; a run is named by what it did, not by its
 * 26-character ULID; a secret is "set" or "not set", never `secret:github-token`.
 *
 * The scan is textual and covers two places:
 *
 * - Copy: every string literal in `applications/interborough/src/app/copy/**` (`.ts`, tests
 *   excluded), with `${...}` interpolations removed.
 * - Templates: the text nodes of each Svelte file under `applications/interborough/src` (`<script>`,
 *   `<style>`, comments and `{...}` expressions removed), and the string value of a `label`, `title`,
 *   `description`, `placeholder`, `aria-label` or `alt` attribute. Test harnesses are not scanned.
 *
 * It reports an absolute path (`/Users/...`, `/home/...`, `/var/...`, `/etc/...`, `/tmp/...`, `/opt/...`,
 * `/usr/...`, `~/...`), a relative path to a file (`./x`, `../x`, or `dir/name.ext` with a source,
 * data or configuration extension), a Crockford ULID (26 characters, the first 0 to 7), a `secret:`
 * reference, a `${{ secrets` expression, and a `workspace:` reference. Offenders from before the
 * guard are listed in `scripts/visible-text-leaks-allowlist.json`, which only shrinks.
 *
 * Runs from the root `lint:guards` script.
 */

import { lineOf, runCountGuard, shorten } from './owner-rule-guard-support';

export const SCANNED_DIRECTORIES = ['applications/interborough/src'];
export const ALLOWLIST_PATH = 'scripts/visible-text-leaks-allowlist.json';
const COPY_DIRECTORY = 'applications/interborough/src/app/copy/';

const EXTENSIONS =
  'ts|js|mjs|json|jsonc|md|svelte|css|html|ya?ml|toml|sqlite|db|log|env|lock|txt|sh';
const LEAKS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  [
    'an absolute path',
    /(?<![\w:/.])(?:\/(?:Users|home|var|etc|tmp|opt|usr|private|Volumes)\/[\w.-]+|~\/[\w.-]+)/,
  ],
  [
    'a relative path',
    new RegExp(
      `(?<![\\w:/.@-])(?:\\.{1,2}/[\\w.-]+|[\\w-]+(?:/[\\w.-]+)*/[\\w-]+\\.(?:${EXTENSIONS})\\b)`,
    ),
  ],
  ['a ULID', /(?<![0-9A-Za-z])[0-7][0-9A-HJKMNP-TV-Z]{25}(?![0-9A-Za-z])/],
  ['a secret reference', /(?<![\w-])secret:\S/],
  ['a secrets expression', /\$\{\{\s*secrets/],
  ['a workspace reference', /(?<![\w-])workspace:[\w*^~@/.-]/],
];

/** What a piece of visible text leaks, one name per kind. */
export function leaksIn(text: string): string[] {
  return LEAKS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

const STRING_LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

/** Every leak in the string literals of a copy file, as `<line> - <kind>: <text>`. */
export function findCopyLeaks(original: string): string[] {
  // A module specifier is a path and not visible text.
  const source = blank(original, /\b(?:from|import)\s*\(?\s*(?:'[^'\n]*'|"[^"\n]*")/g);
  const sites: string[] = [];
  for (const match of source.matchAll(STRING_LITERAL)) {
    const literal = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    for (const name of leaksIn(literal)) {
      sites.push(`${lineOf(source, match.index)} - ${name}: ${shorten(literal, 80)}`);
    }
  }
  return sites;
}

/** Replaces each match of `pattern` with spaces and newlines, so line numbers stay put. */
function blank(source: string, pattern: RegExp): string {
  return source.replace(pattern, (matched) => matched.replace(/[^\n]/g, ' '));
}

const TEXT_ATTRIBUTE =
  /\b(?:label|title|description|placeholder|aria-label|alt)\s*=\s*(?:"([^"{]*)"|'([^'{]*)')/g;

/** Every leak in the text nodes and text attributes of a Svelte template, as `<line> - <kind>: <text>`. */
export function findTemplateLeaks(source: string): string[] {
  let template = blank(
    source,
    /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
  );
  const sites: string[] = [];
  for (const match of template.matchAll(TEXT_ATTRIBUTE)) {
    const value = match[1] ?? match[2] ?? '';
    for (const name of leaksIn(value)) {
      sites.push(`${lineOf(template, match.index)} - ${name}: ${shorten(value, 80)}`);
    }
  }
  // Blank every expression, nested to a few levels, then every tag, leaving only text nodes.
  for (let depth = 0; depth < 4; depth += 1) {
    template = blank(template, /\{[^{}]*\}/g);
  }
  template = blank(template, /<[A-Za-z/][^<>]*>/g);
  for (const match of template.matchAll(/[^<>\n]*[^<>\s][^<>\n]*/g)) {
    const text = match[0].trim();
    for (const name of leaksIn(text)) {
      sites.push(`${lineOf(template, match.index)} - ${name}: ${shorten(text, 80)}`);
    }
  }
  return sites.toSorted((first, second) => Number.parseInt(first) - Number.parseInt(second));
}

/** The leaks in one file: copy files by their string literals, Svelte files by their templates. */
export function findLeaks(source: string, path: string): string[] {
  if (path.endsWith('.svelte')) return findTemplateLeaks(source);
  return path.startsWith(COPY_DIRECTORY) ? findCopyLeaks(source) : [];
}

if (import.meta.main) {
  runCountGuard({
    name: 'check-visible-text-leaks',
    advice:
      'visible text shows a path, a ULID or a secret reference.\n' +
      'Name the thing by what it is (the configuration file, the run, a secret that is set), never\n' +
      'by its path, its identifier or its reference.',
    passed: 'no visible text leaks a path, a ULID or a secret reference beyond the allowlist',
    directories: SCANNED_DIRECTORIES,
    extensions: new Set(['.ts', '.svelte']),
    exclude: /\.(?:test|spec)\.ts$|\.test-harness\.svelte$|\.test-support\.ts$/,
    allowlistPath: ALLOWLIST_PATH,
    find: findLeaks,
  }).catch((error: unknown) => {
    console.error('check-visible-text-leaks failed:', error);
    process.exitCode = 1;
  });
}
