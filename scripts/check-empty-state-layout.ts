/**
 * Keep every empty state in Interborough on Cinder's one `EmptyState` layout.
 *
 * Owner standing order (2026-11-19, "I keep telling you"): an empty state looks the same on every
 * screen. On 2026-11-19 the owner counted six different patterns: the Cinder component in three
 * layouts and two sizes, a hand-rolled `<p class="...__empty">` line, and a bare `{copy.empty}`
 * paragraph. The one pattern is Cinder's `EmptyState` with its defaults.
 *
 * The scan is textual, in each non-test Svelte file under `applications/interborough/src`. It
 * reports:
 *
 * - hand-rolled markup: an element (a lowercase tag) whose `class` holds a word `empty` (such as
 *   `ib-x__empty`, `weft-x-empty` or `empty-actions`), and an element whose only content is a
 *   `{...}` expression that names `empty`;
 * - a variant of the component: an `<EmptyState>` tag that passes `layout`, `size` or `align`.
 *
 * Offenders from before the guard are listed in `scripts/empty-state-layout-allowlist.json`, which
 * only shrinks (`owner-rule-guard-support.ts`).
 *
 * Runs from the root `lint:guards` script.
 */

import { lineOf, runCountGuard, shorten } from './owner-rule-guard-support';

export const SCANNED_DIRECTORIES = ['applications/interborough/src'];
export const ALLOWLIST_PATH = 'scripts/empty-state-layout-allowlist.json';

/** The text of the opening tag that starts at `start`, closed by the first `>` outside braces and quotes. */
function readTag(source: string, start: number): string {
  let depth = 0;
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== '') {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'" || (depth > 0 && character === '`')) {
      quote = character;
    } else if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === '>' && depth <= 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
}

const EMPTY_CLASS = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')|\bclass:([\w-]+)/g;
const EMPTY_WORD = /(?:^|[\s_-])empty(?:$|[\s_-])/;
const VARIANT_PROP = /\s(layout|size|align)\s*=/;

/** Every hand-rolled empty state and every `EmptyState` variant in `source`, as `<line> - <text>`. */
export function findEmptyStates(original: string): string[] {
  const source = original.replace(
    /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
    (matched) => matched.replace(/[^\n]/g, ' '),
  );
  const sites: string[] = [];
  for (const match of source.matchAll(/<([A-Za-z][\w.-]*)(?=[\s/>])/g)) {
    const name = match[1]!;
    const tag = readTag(source, match.index);
    if (name === 'EmptyState') {
      // An expression or a quoted value can name `size = 1` without passing the prop.
      // The shorthand `{layout}` passes the prop too, so it becomes `layout=` before braces go.
      let attributes = tag
        .slice(match[0].length)
        .replace(/"[^"]*"|'[^']*'/g, '""')
        .replace(/(\s)\{\s*(layout|size|align)\s*\}/g, '$1$2=');
      for (let depth = 0; depth < 4; depth += 1) attributes = attributes.replace(/\{[^{}]*\}/g, '');
      const variant = VARIANT_PROP.exec(attributes);
      if (variant !== null) {
        sites.push(`${lineOf(source, match.index)} - EmptyState passes ${variant[1]}`);
      }
    } else if (/^[a-z]/.test(name)) {
      const emptyClass = [...tag.matchAll(EMPTY_CLASS)].some((attribute) =>
        EMPTY_WORD.test(attribute[1] ?? attribute[2] ?? attribute[3] ?? ''),
      );
      const body = /^\s*\{([^{}#/:@][^{}]*)\}\s*(?=<)/.exec(source.slice(match.index + tag.length));
      const emptyBody = body !== null && /(?<![A-Za-z])empty(?![A-Za-z])/i.test(body[1]!);
      if (emptyClass || emptyBody) {
        sites.push(`${lineOf(source, match.index)} - hand-rolled ${shorten(tag, 90)}`);
      }
    }
  }
  return sites;
}

if (import.meta.main) {
  runCountGuard({
    name: 'check-empty-state-layout',
    advice:
      'an empty state is hand-rolled or is a variant of the component.\n' +
      "Use Cinder's EmptyState with its defaults: one layout, no layout, size or align prop.",
    passed: 'every empty state is the one EmptyState layout beyond the allowlist',
    directories: SCANNED_DIRECTORIES,
    extensions: new Set(['.svelte']),
    exclude: /\.test-harness\.svelte$/,
    allowlistPath: ALLOWLIST_PATH,
    find: findEmptyStates,
  }).catch((error: unknown) => {
    console.error('check-empty-state-layout failed:', error);
    process.exitCode = 1;
  });
}
