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
import { buildBaseIndex, buildTokenRegistryFromIndexes, themeAwarePaths } from '../../src/tokens/runtime/registry.ts';
import type { ResolverDocument } from '../../src/tokens/runtime/types.ts';
import type { DocSection } from './docs-sections.ts';
import { buildTokensDocMarkdown, renderDocTable } from './docs.ts';
import { loadCorpus } from './generate.ts';

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

const REAL_SLUG = 'spacing';

function buttonBase(parentHeading: string) {
  return [
    '# Design tokens',
    '',
    parentHeading,
    '',
    '### Base',
    '',
    '<!-- BEGIN GENERATED TOKEN TABLE: button-base -->',
    'stale',
    '<!-- END GENERATED TOKEN TABLE -->',
  ];
}
describe('CIN-30 review round 11: markers must stay under their declared heading', () => {
  const REAL_HEADING = '## Spacing';

  // `DocSection.heading` was set for every section and read by nothing, so it
  // documented a guarantee nothing enforced: moving a marker under another
  // heading left the generator rewriting the spacing table under "Typography",
  // `tokens:generate -- --check` stabilising on it, and the drift test -- which
  // compares tokens globally rather than per section -- still passing.
  test('a marker moved under a different heading is rejected', async () => {
    await expectRejected(
      buildHeadingDocument('## Typography'),
      /marker under headings "## Typography", but DOC_SECTIONS declares it belongs under "## Spacing"/,
    );
  });

  test('a marker before any heading is rejected, naming the absence', async () => {
    const { resolver, documentsByPath } = await loadCorpus();
    const baseIndex = buildBaseIndex(resolver, documentsByPath);
    const markdown = `<!-- BEGIN GENERATED TOKEN TABLE: ${REAL_SLUG} -->\nstale\n<!-- END GENERATED TOKEN TABLE -->\n`;
    await expectRejected(
      buildTokensDocMarkdown(markdown, baseIndex, (value) => value),
      /marker under headings \(none\)/,
    );
  });

  test('a renamed heading is rejected rather than silently accepted', async () => {
    await expectRejected(buildHeadingDocument('## Spacing scale'), /DOC_SECTIONS declares/);
  });

  test('the declared heading still passes', async () => {
    // Fails on the OTHER sections being absent, not on the heading -- which is
    // what proves the heading check itself let this one through.
    await expectRejected(buildHeadingDocument(REAL_HEADING), /is missing a generated-table marker/);
  });
});

async function buildHeadingDocument(headingLine: string) {
  const markdown = [
    '# Design tokens',
    '',
    headingLine,
    '',
    `<!-- BEGIN GENERATED TOKEN TABLE: ${REAL_SLUG} -->`,
    'stale',
    '<!-- END GENERATED TOKEN TABLE -->',
    '',
  ].join('\n');
  const { resolver, documentsByPath } = await loadCorpus();
  const baseIndex = buildBaseIndex(resolver, documentsByPath);
  return buildTokensDocMarkdown(markdown, baseIndex, (value) => value);
}

async function buildNestedHeadingDocument(lines: readonly string[]) {
  const { resolver, documentsByPath } = await loadCorpus();
  const baseIndex = buildBaseIndex(resolver, documentsByPath);
  return buildTokensDocMarkdown([...lines, ''].join('\n'), baseIndex, (value) => value);
}

function buildBlankRecipe(cssRecipe: string) {
  const resolver: ResolverDocument = {
    version: '2025.10',
    sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
    modifiers: {},
    resolutionOrder: [{ $ref: '#/sets/foundation' }],
  };
  const documentsByPath = new Map([
    [
      'base.json',
      {
        foundation: {
          $type: 'dimension',
          swatch: {
            $value: { value: 1, unit: 'rem' },
            $extensions: {
              'com.lostgradient.cinder': {
                cssProperty: '--cinder-test-recipe',
                public: true,
                cssRecipe,
              },
            },
          },
        },
      },
    ],
  ]);
  const baseIndex = buildBaseIndex(resolver, documentsByPath);
  return () => buildTokenRegistryFromIndexes(baseIndex, themeAwarePaths(resolver, documentsByPath));
}

describe('CIN-30 review round 12: nested markers pin their parent heading', () => {
  // Matching only the LEAF heading let `### Base` and its marker move under a
  // different `##` parent intact -- the Button table would land in another
  // section and `tokens:generate -- --check` would stabilise on it.
  test('a nested marker moved under a different parent is rejected', async () => {
    await expectRejected(
      buildNestedHeadingDocument(buttonBase('## Typography')),
      /"## Typography" > "### Base", but DOC_SECTIONS declares it belongs under "## Button" > "### Base"/,
    );
  });

  test('the declared parent still passes the heading check', async () => {
    // Fails on the OTHER sections being absent, not on the headings -- which is
    // what proves the trail check itself let this one through.
    await expectRejected(
      buildNestedHeadingDocument(buttonBase('## Button')),
      /is missing a generated-table marker/,
    );
  });

  // A sibling heading earlier in the document is not an ancestor: the trail
  // must keep only strictly-shallower levels walking backwards.
  test('a preceding sibling heading is not treated as an ancestor', async () => {
    await expectRejected(
      buildNestedHeadingDocument([
        '# Design tokens',
        '',
        '## Button',
        '',
        '### Size: sm',
        '',
        '### Base',
        '',
        '<!-- BEGIN GENERATED TOKEN TABLE: button-base -->',
        'stale',
        '<!-- END GENERATED TOKEN TABLE -->',
      ]),
      /is missing a generated-table marker/,
    );
  });
});

describe('CIN-30 review round 12: a blank cssRecipe is rejected', () => {
  // `cssRecipe` is free-form, so the schema accepts `""` -- and an empty recipe
  // still WINS over the typed $value, emitting a custom property with no value
  // and a documentation row whose Default cell is an empty code span, which
  // `extractDocTokens` cannot match.
  test('an empty cssRecipe is rejected rather than emitted as an empty value', () => {
    expect(buildBlankRecipe('')).toThrow(/has a blank cssRecipe extension/);
  });

  test('a whitespace-only cssRecipe is rejected too', () => {
    expect(buildBlankRecipe('   ')).toThrow(/has a blank cssRecipe extension/);
  });

  test('a real cssRecipe still passes', () => {
    expect(buildBlankRecipe('1rem')).not.toThrow();
  });
});

describe('CIN-30 review round 14', () => {
  // `toTableCell` collapses interior line breaks, so normalization can
  // SYNTHESIZE a marker the raw source does not contain. Validating the raw
  // string accepted this and then wrote the exact closing marker into the block.
  test('a marker split across a newline is caught after normalization', async () => {
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'recipe.split',
        {
          path: 'recipe.split',
          value: { value: 1, unit: 'rem' },
          type: 'dimension',
          description: 'Ends <!-- END\nGENERATED TOKEN TABLE --> here.',
          cssProperty: '--cinder-test-split',
          cssRecipe: undefined,
          public: true,
          category: 'spacing',
          component: undefined,
          deprecated: undefined,
        },
      ],
    ]);
    const section: DocSection = {
      slug: 'split',
      headings: ['## Split'],
      cssProperties: ['--cinder-test-split'],
    };

    await expectRejected(
      renderDocTable(section, baseIndex, (value) => value),
      /description for "--cinder-test-split" contains the generated-table marker/,
    );
  });

  // A suffix match over label-only entries accepted a DEMOTED section: turning
  // `## Spacing` into `### Spacing` beneath `## Typography` still ends in
  // "Spacing", so the spacing table would nest under Typography unnoticed.
  test('a demoted section heading is rejected, not just a moved one', async () => {
    const { resolver, documentsByPath } = await loadCorpus();
    const baseIndex = buildBaseIndex(resolver, documentsByPath);
    const markdown = [
      '# Design tokens',
      '',
      '## Typography',
      '',
      '### Spacing',
      '',
      '<!-- BEGIN GENERATED TOKEN TABLE: spacing -->',
      'stale',
      '<!-- END GENERATED TOKEN TABLE -->',
      '',
    ].join('\n');

    await expectRejected(
      buildTokensDocMarkdown(markdown, baseIndex, (value) => value),
      /"## Typography" > "### Spacing", but DOC_SECTIONS declares it belongs under "## Spacing"/,
    );
  });
});
