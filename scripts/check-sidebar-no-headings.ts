/**
 * Ban a visible section heading in Interborough's sidebar.
 *
 * Owner standing order (2026-11-19, "I keep telling you"): the sidebar's rows are not grouped under
 * "Work", "Build" and "System" headings. The sections stay named for a screen reader, and the
 * sidebar draws no header at all. In Cinder a section is a `SideNavigationGroup`, and it draws a
 * heading (a plain label or a folding trigger) unless it is a static group with
 * `labelVisibility="hidden"`, which names its list with `aria-label` and draws nothing.
 *
 * The scan is textual: in each non-test Svelte file under `applications/interborough/src` it reads
 * every `<SideNavigationGroup ...>` opening tag, across lines, and reports one that does not carry
 * `labelVisibility="hidden"`. A tag whose `collapsible` is not literally `{false}` is reported too,
 * because a collapsible group needs its visible trigger. Test harnesses (`*.test-harness.svelte`)
 * are not scanned. The sidebar written before the guard is listed in
 * `scripts/sidebar-no-headings-allowlist.json`, which only shrinks (`owner-rule-guard-support.ts`).
 *
 * Runs from the root `lint:guards` script.
 */

import { lineOf, runCountGuard, shorten } from './owner-rule-guard-support';

export const SCANNED_DIRECTORIES = ['applications/interborough/src'];
export const ALLOWLIST_PATH = 'scripts/sidebar-no-headings-allowlist.json';

const GROUP_TAG = /<SideNavigationGroup(?=[\s/>])(?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*>/g;
const HIDDEN_LABEL = /\blabelVisibility\s*=\s*(?:"hidden"|'hidden'|\{\s*['"]hidden['"]\s*\})/;
const STATIC_GROUP = /\bcollapsible\s*=\s*\{\s*false\s*\}/;

/** Every `<SideNavigationGroup>` tag in `source` that would draw a heading, as `<line> - <tag>`. */
export function findSidebarHeadings(source: string): string[] {
  const sites: string[] = [];
  for (const match of source.matchAll(GROUP_TAG)) {
    const tag = match[0];
    if (HIDDEN_LABEL.test(tag) && STATIC_GROUP.test(tag)) continue;
    sites.push(`${lineOf(source, match.index)} - ${shorten(tag)}`);
  }
  return sites;
}

if (import.meta.main) {
  runCountGuard({
    name: 'check-sidebar-no-headings',
    advice:
      'a sidebar section draws a visible heading.\n' +
      'The sidebar groups its rows with no header at all: pass labelVisibility="hidden" and\n' +
      'collapsible={false} to the SideNavigationGroup, which names its list for a screen reader.',
    passed: 'no sidebar section draws a heading beyond the allowlist',
    directories: SCANNED_DIRECTORIES,
    extensions: new Set(['.svelte']),
    exclude: /\.test-harness\.svelte$/,
    allowlistPath: ALLOWLIST_PATH,
    find: findSidebarHeadings,
  }).catch((error: unknown) => {
    console.error('check-sidebar-no-headings failed:', error);
    process.exitCode = 1;
  });
}
