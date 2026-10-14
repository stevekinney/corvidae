/**
 * Regression tests for the token documentation artifact generator.
 *
 *   - `renderDocTable` must normalize a `$description` containing a
 *     newline before interpolating it into a Markdown table cell -- raw
 *     sanitization only escapes `|`, so an embedded newline breaks the row.
 *
 * None of these fixtures touch the real corpus under `src/tokens/`, so a fix
 * here can never change what `tokens:generate` emits for the committed
 * files (documentation/tokens.md's real $description text has no newline in it --
 * see `completeness.test.ts`'s sibling `registry.test.ts`/`generate.test.ts`
 * files for the equivalent "this fixture is synthetic" note).
 */

import { describe, expect, test } from 'bun:test';
import { type CorpusEntry } from '../../src/tokens/runtime/corpus.ts';
import type { DocSection } from './docs-sections.ts';
import { renderDocTable } from './docs.ts';
describe('CIN-470: toTableCell escapes pipes by backslash parity, not unconditionally', () => {
  /**
   * Counts the STRUCTURAL number of GFM column delimiters in a row: a `|` is a
   * delimiter unless it is preceded by an odd run of backslashes (GFM's own
   * left-to-right backslash pairing -- the same rule `toTableCell` targets),
   * in which case it is an escaped, literal pipe inside a cell. Asserting this
   * count -- not a literal backslash count in the row's text, which is easy to
   * miscount by hand -- is what actually proves the row is well-formed.
   */

  // `cssRecipe` is emitted verbatim by `serializeEntryValue` (cssRecipe > alias >
  // typed `$value`, see generate.ts), so it is the clean way to inject an exact
  // string into a cell without a typed `$value`/serialization detour.
  //
  // Typed `fontFamily` rather than `color`: these values (`foo|bar`,
  // `*<em>`|&</em>*`) are Markdown-escaping fixtures, not colors, and CIN-242's
  // complete-color-value gate rejects a color token that serializes to
  // something which is not a CSS color. The escaping this exercises is
  // type-independent.

  test('a bare pipe still produces a well-formed 3-column row (4 delimiters)', async () => {
    const baseIndex = new Map<string, CorpusEntry>([
      recipeEntry('test.bare', '--test-bare', 'foo|bar'),
    ]);
    const table = await renderDocTable(tableSection('--test-bare'), baseIndex, (value) => value);
    expect(countRowDelimiters(rowFor(table, '--test-bare'))).toBe(4);
  });

  test('a value already containing an escaped pipe is not double-escaped into a malformed row', async () => {
    // Pre-fix, `.replaceAll('|', '\\|')` turned this already-escaped `foo\|bar`
    // into `foo\\|bar`: GFM reads the leading `\\` as an escaped backslash,
    // leaving the `|` a live, unescaped column delimiter -- a 5-delimiter row
    // the drift parser (`extractDocTokens`) still silently accepted.
    const baseIndex = new Map<string, CorpusEntry>([
      recipeEntry('test.escaped', '--test-escaped', 'foo\\|bar'),
    ]);
    const table = await renderDocTable(tableSection('--test-escaped'), baseIndex, (value) => value);
    expect(countRowDelimiters(rowFor(table, '--test-escaped'))).toBe(4);
  });

  test('both cases decode back to their original values through the drift parser inverse', async () => {
    // Mirrors `tokens-doc-drift.test.ts`'s `extractDocTokens` decode exactly,
    // so this test fails the same way that test would if the two sides ever
    // disagreed again.
    for (const raw of ['foo|bar', 'foo\\|bar']) {
      const baseIndex = new Map<string, CorpusEntry>([recipeEntry('test.rt', '--test-rt', raw)]);
      const table = await renderDocTable(tableSection('--test-rt'), baseIndex, (value) => value);
      const row = rowFor(table, '--test-rt');
      // Pipe-containing values use an HTML code element so entities render as
      // literal characters without becoming Markdown table delimiters.
      const cellMatch = /\|\s*`--test-rt`\s*\|\s*((?:\\.|[^|])*)\s*\|/.exec(row);
      expect(cellMatch?.[1]).toBeDefined();
      const encoded = cellMatch![1]!.trim().replace(/^<code>|<\/code>$/g, '');
      const decoded = encoded.replace(
        /&#(?:x([0-9a-f]+)|(\d+));/gi,
        (_entity, hex: string, decimal: string) =>
          String.fromCodePoint(Number.parseInt(hex ?? decimal, hex ? 16 : 10)),
      );
      expect(decoded).toBe(raw);
    }
  });

  test('a pipe value is rendered as literal-safe HTML code', async () => {
    const baseIndex = new Map<string, CorpusEntry>([
      recipeEntry('test.literal', '--test-literal', '*<em>`|&</em>*'),
    ]);
    const table = await renderDocTable(tableSection('--test-literal'), baseIndex, (value) => value);
    expect(table).toContain('<code>&#42;&lt;em&gt;`&#x7c;&amp;&lt;/em&gt;&#42;</code>');
    expect(table).not.toContain('<em>');
  });

  test('Markdown-active punctuation round-trips unchanged in an HTML token cell', async () => {
    const baseIndex = new Map<string, CorpusEntry>([
      recipeEntry('test.markdown', '--test-markdown', '*A*|_B_~C~'),
    ]);
    const table = await renderDocTable(
      tableSection('--test-markdown'),
      baseIndex,
      (value) => value,
    );
    expect(table).toContain('<code>&#42;A&#42;&#x7c;&#95;B&#95;&#126;C&#126;</code>');
  });
});

function countRowDelimiters(row: string): number {
  let count = 0;
  let backslashRun = 0;
  for (const character of row) {
    if (character === '\\') {
      backslashRun += 1;
      continue;
    }
    if (character === '|' && backslashRun % 2 === 0) count += 1;
    backslashRun = 0;
  }
  return count;
}

function recipeEntry(path: string, cssProperty: string, cssRecipe: string): [string, CorpusEntry] {
  return [
    path,
    {
      path,
      value: undefined,
      type: 'fontFamily',
      description: undefined,
      cssProperty,
      cssRecipe,
    },
  ];
}

function tableSection(cssProperty: string): DocSection {
  return { slug: 'pipe-test', headings: ['Pipe test'], cssProperties: [cssProperty] };
}

function rowFor(table: string, cssProperty: string): string {
  const row = table.split('\n').find((line) => line.includes(cssProperty));
  if (!row) throw new Error(`No row found for "${cssProperty}" in:\n${table}`);
  return row;
}
