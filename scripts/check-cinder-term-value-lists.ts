/**
 * Keep Interborough's term and value lists on Cinder's components.
 *
 * Owner complaint (2026-11-25): label and value pairs were drawn as two lines each where a Cinder
 * component puts them on one. A page that hand-builds a term and value list with a raw `<dl>`
 * drifts from Cinder's layout. Term and value pairs render through Cinder's `DescriptionList`,
 * `Inspector` or `KeyFacts`.
 *
 * The scan is textual, in each non-test Svelte file under `applications/interborough/src`. It
 * reports a raw `<dl` element (comments, scripts and styles are ignored). Identifiers in prose are
 * left to the geometry probe, because a static scan cannot tell an identifier from a word.
 *
 * Offenders from before the guard are listed in `scripts/cinder-term-value-lists-allowlist.json`,
 * which only shrinks (`owner-rule-guard-support.ts`).
 *
 * Runs from the root `lint:guards` script.
 */

import { lineOf, runCountGuard } from './owner-rule-guard-support';

export const SCANNED_DIRECTORIES = ['applications/interborough/src'];
export const ALLOWLIST_PATH = 'scripts/cinder-term-value-lists-allowlist.json';

/** Every raw `<dl` element in `original`, as `<line> - <text>`. */
export function findRawDescriptionLists(original: string): string[] {
  const source = original.replace(
    /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
    (matched) => matched.replace(/[^\n]/g, ' '),
  );
  return [...source.matchAll(/<dl(?=[\s/>])/g)].map(
    (match) => `${lineOf(source, match.index)} - raw <dl>`,
  );
}

if (import.meta.main) {
  runCountGuard({
    name: 'check-cinder-term-value-lists',
    advice:
      'a term and value list is a raw <dl>.\n' +
      "Use Cinder's DescriptionList, Inspector or KeyFacts, which put each pair on one line.",
    passed: 'every term and value list is a Cinder component beyond the allowlist',
    directories: SCANNED_DIRECTORIES,
    extensions: new Set(['.svelte']),
    exclude: /\.test-harness\.svelte$/,
    allowlistPath: ALLOWLIST_PATH,
    find: findRawDescriptionLists,
  }).catch((error: unknown) => {
    console.error('check-cinder-term-value-lists failed:', error);
    process.exitCode = 1;
  });
}
