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
import { DOC_MARKER_PATTERN, buildTokensDocMarkdown, renderDocTable } from './docs.ts';

async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(pattern);
}
describe('B2: renderDocTable normalizes a newline in $description', () => {
  test('a description containing a newline stays on one table row', async () => {
    const section: DocSection = {
      slug: 'test-section',
      headings: ['Test section'],
      cssProperties: ['--cinder-test-token'],
    };
    const entry: CorpusEntry = {
      path: 'test.token',
      value: { value: 1, unit: 'rem' },
      type: 'dimension',
      description: 'Line one.\nLine two.',
      cssProperty: '--cinder-test-token',
      cssRecipe: undefined,
    };
    const baseIndex = new Map<string, CorpusEntry>([[entry.path, entry]]);

    const table = await renderDocTable(section, baseIndex, (value) => value);

    // Pre-fix: sanitization only escaped `|`, so the raw newline is
    // interpolated straight into the row, and the second line ("Line two. |")
    // is no longer prefixed by `|`, so it is not part of any table row --
    // splitting one token's row into a malformed fragment.
    expect(table).not.toContain('Line one.\nLine two.');
    const rowLines = table.split('\n').filter((line) => line.includes('--cinder-test-token'));
    expect(rowLines).toHaveLength(1);
    expect(rowLines[0]).toContain('Line one. Line two.');
  });

  test('a lone \\r (not just \\n or \\r\\n) is also normalized', async () => {
    // CommonMark treats a bare "\r" as a line ending on its own, just like
    // "\n" and "\r\n" -- a fix that only matches the regex character class
    // `\n` would miss this case and still truncate the table on an
    // old-Mac-style line break.
    const section: DocSection = {
      slug: 'test-section-cr',
      headings: ['Test section'],
      cssProperties: ['--cinder-test-token-cr'],
    };
    const entry: CorpusEntry = {
      path: 'test.token.cr',
      value: { value: 1, unit: 'rem' },
      type: 'dimension',
      description: 'Line one.\rLine two.',
      cssProperty: '--cinder-test-token-cr',
      cssRecipe: undefined,
    };
    const baseIndex = new Map<string, CorpusEntry>([[entry.path, entry]]);

    const table = await renderDocTable(section, baseIndex, (value) => value);
    const rowLines = table.split('\n').filter((line) => line.includes('--cinder-test-token-cr'));
    expect(rowLines).toHaveLength(1);
    expect(rowLines[0]).toContain('Line one. Line two.');
  });
});

function markerEntry(field: 'description' | 'cssRecipe', text: string) {
  const entry: CorpusEntry = {
    path: 'recipe.marker',
    value: { value: 1, unit: 'rem' },
    type: 'dimension',
    description: field === 'description' ? text : 'A token.',
    cssProperty: '--cinder-test-marker',
    cssRecipe: field === 'cssRecipe' ? text : undefined,
    public: true,
    category: 'spacing',
    component: undefined,
    deprecated: undefined,
  };
  return new Map<string, CorpusEntry>([['recipe.marker', entry]]);
}

describe('CIN-30 review round 3', () => {
  test('a pipe in a serialized value is escaped so the table row stays well-formed', async () => {
    // GFM treats `|` as a column delimiter even inside a backtick code span, so
    // a fontFamily whose family name contains one would commit a malformed row
    // that the drift parser still reads back successfully.
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'font.piped',
        {
          path: 'font.piped',
          value: ['A|B'],
          type: 'fontFamily',
          description: 'A piped family.',
          cssProperty: '--cinder-test-font-piped',
          cssRecipe: undefined,
          public: true,
          category: 'typography',
          component: undefined,
          deprecated: undefined,
        },
      ],
    ]);
    const section: DocSection = {
      slug: 'piped',
      headings: ['Piped'],
      cssProperties: ['--cinder-test-font-piped'],
    };
    const table = await renderDocTable(section, baseIndex, (value) => value);

    // Exactly three unescaped cell delimiters on the row: leading, between the
    // two cells, and between value and description, plus the trailing one.
    const row = table.split('\n').find((line) => line.includes('--cinder-test-font-piped')) ?? '';
    expect(row).toContain('<code>&#39;A&#x7c;B&#39;</code>');
    expect(row).not.toContain('`&#39;A&#x7c;B&#39;`');
    expect(row.replace(/\\\|/g, '').split('|').length - 1).toBe(4);
  });

  test('an ordinary serialized value is wrapped in exactly one code span', async () => {
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'space.zero',
        {
          path: 'space.zero',
          value: { value: 0, unit: 'px' },
          type: 'dimension',
          description: 'Zero spacing.',
          cssProperty: '--cinder-test-space-zero',
          cssRecipe: undefined,
          public: true,
          category: 'spacing',
          component: undefined,
          deprecated: undefined,
        },
      ],
    ]);
    const section: DocSection = {
      slug: 'spacing',
      headings: ['Spacing'],
      cssProperties: ['--cinder-test-space-zero'],
    };

    const table = await renderDocTable(section, baseIndex, (value) => value);
    const row = table.split('\n').find((line) => line.includes('--cinder-test-space-zero')) ?? '';

    expect(row).toMatch(/\| `0`\s+\|/);
    expect(row).not.toContain('`` `0` ``');
  });
});

describe('CIN-30 review round 5', () => {
  test('a multi-line value is normalized onto one row, like a multi-line description', async () => {
    // A cssRecipe formatted across lines returns those breaks verbatim from
    // serializeEntryValue; interpolated raw they terminate the table row.
    // Descriptions were normalized three rounds before values were -- both now
    // route through the same toTableCell, so a hazard cannot be fixed on one
    // cell and missed on the other.
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'shadow.multi',
        {
          path: 'shadow.multi',
          value: { value: 1, unit: 'rem' },
          type: 'dimension',
          description: 'Line one.\nLine two.',
          cssProperty: '--cinder-test-multiline',
          cssRecipe: '0 1px 2px rgb(0 0 0 / 0.1),\n  0 2px 4px rgb(0 0 0 / 0.1)',
          public: true,
          category: 'shadow',
          component: undefined,
          deprecated: undefined,
        },
      ],
    ]);
    const section: DocSection = {
      slug: 'multi',
      headings: ['Multi'],
      cssProperties: ['--cinder-test-multiline'],
    };
    const table = await renderDocTable(section, baseIndex, (value) => value);
    const rows = table.split('\n').filter((line) => line.includes('--cinder-test-multiline'));

    // Exactly one row carries the token, and neither cell leaked a line break.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('0 1px 2px rgb(0 0 0 / 0.1), 0 2px 4px rgb(0 0 0 / 0.1)');
    expect(rows[0]).toContain('Line one. Line two.');
  });

  test('a section marker repeated in the document is rejected', async () => {
    // Regenerating both blocks would list every token in the section twice, and
    // `tokens:generate -- --check` would then stabilise on the doubled output.
    // Uses control-heights (four tokens) so the FIRST block renders cleanly and
    // the duplicate is what fails -- a larger section would fail on the fixture
    // being incomplete instead, which would not test this at all.
    const heights = ['xs', 'sm', 'md', 'lg'];
    const baseIndex = new Map<string, CorpusEntry>(
      heights.map((size) => [
        `control.height.${size}`,
        {
          path: `control.height.${size}`,
          value: { value: 1, unit: 'rem' },
          type: 'dimension' as const,
          description: `Control height ${size}.`,
          cssProperty: `--cinder-control-height-${size}`,
          cssRecipe: undefined,
          public: true,
          category: 'size',
          component: undefined,
          deprecated: undefined,
        },
      ]),
    );
    const marker = '<!-- BEGIN GENERATED TOKEN TABLE: control-heights -->';
    // Both copies sit under the heading DOC_SECTIONS declares, so this reaches
    // the duplicate check rather than tripping the heading check first.
    const doubled = [
      '## Control heights',
      '',
      marker,
      '<!-- END GENERATED TOKEN TABLE -->',
      '',
      '## Control heights',
      '',
      marker,
      '<!-- END GENERATED TOKEN TABLE -->',
      '',
    ].join('\n');

    await expectRejected(
      buildTokensDocMarkdown(doubled, baseIndex, (value) => value),
      /more than one generated-table marker for section "control-heights"/,
    );
  });
});

describe('CIN-30 review round 6', () => {
  test('a value containing a backtick gets a longer delimiter run, not a broken span', async () => {
    // CommonMark closes a code span at the first matching backtick run, so a
    // hard-coded single backtick would end the span inside the value -- emitting
    // malformed Markdown that the drift parser then reads back truncated.
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'font.ticked',
        {
          path: 'font.ticked',
          value: ['A`B'],
          type: 'fontFamily',
          description: 'A ticked family.',
          cssProperty: '--cinder-test-font-ticked',
          cssRecipe: undefined,
          public: true,
          category: 'typography',
          component: undefined,
          deprecated: undefined,
        },
      ],
    ]);
    const section: DocSection = {
      slug: 'ticked',
      headings: ['Ticked'],
      cssProperties: ['--cinder-test-font-ticked'],
    };
    const table = await renderDocTable(section, baseIndex, (value) => value);
    const row = table.split('\n').find((line) => line.includes('--cinder-test-font-ticked')) ?? '';

    // The value's span is delimited by a run of two, so the single backtick
    // inside it cannot close it early.
    expect(row).toContain('``');
    expect(row).toContain('A`B');
  });
});

describe('CIN-30 review round 9', () => {
  const section: DocSection = {
    slug: 'marker',
    headings: ['Marker'],
    cssProperties: ['--cinder-test-marker'],
  };

  // Writing marker text into the block makes the NEXT scan stop at the injected
  // text: the rewrite keeps only the truncated prefix, strands the remainder,
  // and `tokens:generate -- --check` can never stabilize again.
  test('a description carrying the END marker is rejected instead of written into the block', async () => {
    const index = markerEntry('description', 'Ends <!-- END GENERATED TOKEN TABLE --> here.');
    await expectRejected(
      renderDocTable(section, index, (value) => value),
      /description for "--cinder-test-marker" contains the generated-table marker/,
    );
  });

  test('a value carrying the BEGIN marker is rejected too, not just a description', async () => {
    const index = markerEntry('cssRecipe', '<!-- BEGIN GENERATED TOKEN TABLE: spacing -->');
    await expectRejected(
      renderDocTable(section, index, (value) => value),
      /value for "--cinder-test-marker" contains the generated-table marker/,
    );
  });

  test('a description with no marker text still renders', async () => {
    const index = markerEntry('description', 'A spacing token.');
    const table = await renderDocTable(section, index, (value) => value);
    expect(table).toContain('--cinder-test-marker');
  });

  // The repository pins no `eol` in .gitattributes, so a checkout with
  // core.autocrlf=true hands the generator CRLF markers. Matching only `\n`
  // found zero blocks, and buildTokensDocMarkdown then reports every
  // DOC_SECTIONS entry as a missing marker while every marker is present.
  test('DOC_MARKER_PATTERN matches a CRLF block, not only an LF one', () => {
    const lf =
      '<!-- BEGIN GENERATED TOKEN TABLE: spacing -->\nstale\n<!-- END GENERATED TOKEN TABLE -->';
    const crlf = lf.replaceAll('\n', '\r\n');

    expect([...lf.matchAll(DOC_MARKER_PATTERN)].map((match) => match[1])).toEqual(['spacing']);
    expect([...crlf.matchAll(DOC_MARKER_PATTERN)].map((match) => match[1])).toEqual(['spacing']);
  });
});
