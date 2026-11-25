/**
 * Keep margin, padding, gap and inset values on Cinder's spacing scale.
 *
 * Owner standing order: spacing that is not from the scale is how a caption ends up 4px under its
 * table. Until this guard only the review's geometry audit noticed an off-scale gap, after the page
 * was built. Cinder's defaults were the largest source of the owner's defects, so Cinder is in scope.
 *
 * The scan is textual, in each `.css` file and each `<style>` block of a `.svelte` file under
 * `components/cinder/src`, `components/chat/src` and `applications/interborough/src`. It reports a
 * `margin`, `margin-*`, `padding`, `padding-*`, `gap`, `row-gap`, `column-gap`, `inset` or `inset-*`
 * declaration whose value holds a px, rem or em length (negative included) other than `0` and
 * `1px`, even one equal to a scale step (so a change to the scale reaches it) and even inside a
 * `calc()` that holds no `--cinder-space-*` token. Percentages, `ch` and `auto` are not reported.
 *
 * The token sources under `components/cinder/src/tokens/` define the scale and are exempt. Only
 * files tracked by git are scanned, so the generated, git-ignored token stylesheet never is.
 *
 * Offenders from before the guard are listed in `scripts/spacing-tokens-allowlist.json`, which only
 * shrinks (`owner-rule-guard-support.ts`).
 *
 * Runs from the root `lint:guards` script.
 */

import { lineOf, repositoryRoot, runCountGuard, shorten } from './owner-rule-guard-support';

export const SCANNED_DIRECTORIES = [
  'components/cinder/src',
  'components/chat/src',
  'applications/interborough/src',
];
export const EXEMPT_DIRECTORY = 'components/cinder/src/tokens/';
export const ALLOWLIST_PATH = 'scripts/spacing-tokens-allowlist.json';

const PROPERTY = '(?:margin|padding|inset)(?:-[a-z-]+)?|gap|row-gap|column-gap';
const DECLARATION = new RegExp(`(?<![\\w-])(${PROPERTY})\\s*:\\s*([^;{}]+)`, 'g');
const LENGTH = /(?<![\w.-])(-?(?:\d+\.?\d*|\.\d+))(rem|em|px)(?![\w-])/gi;

/** Blanks every character of `text` except newlines, so offsets and line numbers survive. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** The value holds a px, rem or em length that is not zero and not `1px`. */
export function hasOffScaleLength(value: string): boolean {
  for (const match of value.matchAll(LENGTH)) {
    const amount = Math.abs(Number.parseFloat(match[1]!));
    if (amount === 0) continue;
    if (amount === 1 && match[2]!.toLowerCase() === 'px') continue;
    return true;
  }
  return false;
}

/** Every off-scale spacing declaration in `source`, as `<line> - <declaration>`. */
export function findOffScaleSpacing(original: string, path = 'file.css'): string[] {
  let source = original.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (path.endsWith('.svelte')) {
    let kept = '';
    let cursor = 0;
    for (const block of source.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/g)) {
      const bodyStart = block.index + block[1]!.length;
      kept += blank(source.slice(cursor, bodyStart)) + block[2]!;
      cursor = bodyStart + block[2]!.length;
    }
    source = kept + blank(source.slice(cursor));
  }
  const sites: string[] = [];
  for (const match of source.matchAll(DECLARATION)) {
    if (hasOffScaleLength(match[2]!)) {
      sites.push(`${lineOf(source, match.index)} - ${shorten(`${match[1]}: ${match[2]}`, 90)}`);
    }
  }
  return sites;
}

/** Keeps the `.css` and `.svelte` files outside the token sources. */
export function filterSpacingFiles(files: readonly string[]): string[] {
  return files.filter(
    (file) => /\.(?:css|svelte)$/.test(file) && !file.startsWith(EXEMPT_DIRECTORY),
  );
}

/** The git-tracked files to scan, relative to the repository root. */
export function trackedSpacingFiles(listTracked: () => string = gitListTracked): string[] {
  return filterSpacingFiles(listTracked().split('\0'));
}

/** `git ls-files` over the scanned directories: tracked files only, so ignored output is never read. */
function gitListTracked(): string {
  const listed = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--', ...SCANNED_DIRECTORIES.map((directory) => `${directory}/`)],
    { cwd: repositoryRoot },
  );
  if (listed.exitCode !== 0) throw new Error('git ls-files failed');
  return listed.stdout.toString();
}

if (import.meta.main) {
  runCountGuard({
    name: 'check-spacing-tokens',
    advice:
      'a margin, padding, gap or inset value is a raw px, rem or em length.\n' +
      'Use a Cinder spacing token, such as var(--cinder-space-3), so the scale reaches it.',
    passed: 'every spacing value is from the scale beyond the allowlist',
    directories: SCANNED_DIRECTORIES,
    extensions: new Set(['.css', '.svelte']),
    listFiles: trackedSpacingFiles,
    allowlistPath: ALLOWLIST_PATH,
    find: findOffScaleSpacing,
  }).catch((error: unknown) => {
    console.error('check-spacing-tokens failed:', error);
    process.exitCode = 1;
  });
}
