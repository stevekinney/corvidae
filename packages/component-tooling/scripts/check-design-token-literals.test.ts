/**
 * Tests for the design-token literal-bypass matchers.
 *
 * This guard had no test file, and it shows: it shipped a hand-written literal
 * list that had gone stale against the corpus, and then a matcher that could
 * not see a multi-line declaration. Both classes reported a clean tree while
 * real bypasses sat in component CSS. Each case below pins one of those.
 */

import { describe, expect, test } from 'bun:test';

import {
  findFixtureLiterals,
  inspectFixtureStyles,
  newFixtureLiterals,
} from './check-browser-fixture-token-literals.ts';
import {
  FONT_WEIGHT_LITERAL_PATTERN,
  TIMING_LITERAL_PATTERN,
  durationLiterals,
  fontWeightTokens,
} from './check-design-token-literals.ts';

describe('TIMING_LITERAL_PATTERN', () => {
  test('matches a single-line transition carrying a token duration', () => {
    expect(TIMING_LITERAL_PATTERN.test('  transition: opacity 200ms ease;')).toBe(true);
  });

  // The blind spot that let two real bypasses through: `.*?` under the `m` flag
  // stops at the first newline, so a formatted multi-value declaration hid its
  // durations entirely and the guard reported OK.
  test('matches a MULTILINE transition, not just a single-line one', () => {
    const declaration = [
      '    transition:',
      '      transform 200ms ease,',
      '      opacity 200ms ease;',
    ].join('\n');
    expect(TIMING_LITERAL_PATTERN.test(declaration)).toBe(true);
  });

  test('matches a multiline animation as well as a transition', () => {
    const declaration = ['  animation:', '    cinder-spin 750ms linear infinite;'].join('\n');
    expect(TIMING_LITERAL_PATTERN.test(declaration)).toBe(true);
  });

  // `[^;{}]` rather than `[\s\S]`: the match must stay inside one declaration so
  // an unterminated value cannot run on and flag a literal belonging to a later
  // rule, which would be a false positive in a different file's worth of CSS.
  test('does not run past the end of a declaration into a later rule', () => {
    const source = ['  transition: opacity ease;', '}', '.other {', '  padding: 200ms;'].join('\n');
    expect(TIMING_LITERAL_PATTERN.test(source)).toBe(false);
  });

  test('does not match a duration with no corresponding token', () => {
    // 150ms was hardcoded by the previous guard and has no token today, so
    // there is nothing to bypass.
    expect(durationLiterals()).not.toContain('150ms');
    expect(TIMING_LITERAL_PATTERN.test('  transition: opacity 150ms ease;')).toBe(false);
  });

  test('derives both the ms and s spellings of each duration', () => {
    const literals = durationLiterals();
    expect(literals).toContain('1.4s');
    expect(literals).toContain('1400ms');
  });
});

describe('FONT_WEIGHT_LITERAL_PATTERN', () => {
  test('matches every weight that has a token, not only 500 and 600', () => {
    for (const value of fontWeightTokens().keys()) {
      expect(FONT_WEIGHT_LITERAL_PATTERN.test(`  font-weight: ${value};`)).toBe(true);
    }
  });

  test('does not match a weight with no token', () => {
    expect(fontWeightTokens().has('550')).toBe(false);
    expect(FONT_WEIGHT_LITERAL_PATTERN.test('  font-weight: 550;')).toBe(false);
  });

  // The remediation advice is derived from this same map. Pairing them is what
  // stops the guard telling someone who wrote `400` to use `--cinder-font-medium`.
  test('pairs each weight with its own token rather than a fixed pair', () => {
    expect(fontWeightTokens().get('400')).toBe('--cinder-font-normal');
    expect(fontWeightTokens().get('700')).toBe('--cinder-font-bold');
  });
});

describe('browser fixture literals', () => {
  test('rejects inline fixture styles even when they use tokens or dynamic values', () => {
    const source = [
      '<div style="gap: var(--cinder-space-2)"></div>',
      '<div style:inline-size={width}></div>',
      '<Stack style={layout}><div class="gap-2">Example</div></Stack>',
      '<Table scrollContainerProps={{ style: tableLayout }} />',
      '<!-- <div style="width: 12rem"></div> -->',
      '<style>.narrow { inline-size: 12rem; }</style>',
    ].join('\n');

    expect(inspectFixtureStyles(source, 'fixture.svelte').inlineStyleLines).toEqual([1, 2, 3, 4]);
  });

  test('finds paint and dimensions in inline, directive, and block styles', () => {
    const source = [
      '<Container style="max-inline-size: 40rem; padding: var(--cinder-space-2) 8px;">',
      '  <div style:background-color={"rebeccapurple"}>Sample</div>',
      '</Container>',
      '<style>',
      '  .sample { gap: calc(var(--cinder-space-2) + 3px); color: #abc8; }',
      '  .sample { background: linear-gradient(rgb(2 3 4), var(--cinder-surface)); }',
      '</style>',
    ].join('\n');

    expect(findFixtureLiterals(source, 'fixture.svelte')).toEqual([
      { line: 1, property: 'max-inline-size', value: '40rem' },
      { line: 1, property: 'padding', value: 'var(--cinder-space-2) 8px' },
      { line: 2, property: 'background-color', value: 'rebeccapurple' },
      { line: 5, property: 'gap', value: 'calc(var(--cinder-space-2) + 3px)' },
      { line: 5, property: 'color', value: '#abc8' },
      {
        line: 6,
        property: 'background',
        value: 'linear-gradient(rgb(2 3 4), var(--cinder-surface))',
      },
    ]);
  });

  test('checks static fragments of authored template and object styles', () => {
    const source = [
      '<Table scrollContainerProps={{ style: "height: 12rem" }} />',
      '<div style={`inline-size: ${width}px; gap: 12px;`}></div>',
      '<div style={active ? "color: white;" : "color: var(--cinder-text-default)"}></div>',
    ].join('\n');

    expect(findFixtureLiterals(source, 'fixture.svelte')).toEqual([
      { line: 1, property: 'height', value: '12rem' },
      { line: 2, property: 'gap', value: '12px' },
      { line: 3, property: 'color', value: 'white' },
    ]);
  });

  test('checks CSS sidecars and literal SVG paint but permits sample component props', () => {
    expect(
      findFixtureLiterals(
        '@media (min-width: 40rem) { .fixture { font-size: 13px; border-radius: 4px; } }',
        'fixture.css',
      ),
    ).toEqual([
      { line: 1, property: 'font-size', value: '13px' },
      { line: 1, property: 'border-radius', value: '4px' },
    ]);
    expect(
      findFixtureLiterals(
        '<ColorPicker value="red" /><svg><path fill="red" stroke="currentColor" /></svg>',
        'fixture.svelte',
      ),
    ).toEqual([{ line: 1, property: 'fill', value: 'red' }]);
  });

  test('allows sample colors, comments, responsive thresholds, fluid sizes, and theme colors', () => {
    const source = [
      '<script>const sample = "width: 15px";</script>',
      '<ColorPicker value="#ffffff" />',
      '<!-- <div style="width: 15px"></div> -->',
      '<style>',
      '  /* gap: 7px */',
      '  @container (max-width: 40rem) {',
      '    .sample::before { content: "120px"; color: currentColor; }',
      '    .sample {',
      '      width: 100%; padding: 0 var(--cinder-space-3, 12px);',
      '      background: color-mix(in oklch, var(--cinder-surface), transparent 30%);',
      '      background-image: url("/sample/#aaa");',
      '    }',
      '  }',
      '</style>',
    ].join('\n');

    expect(findFixtureLiterals(source, 'fixture.svelte')).toEqual([]);
  });

  test('rejects new or repeated declarations within a baselined file', () => {
    const previous = [{ line: 1, property: 'gap', value: '8px' }];
    expect(newFixtureLiterals([{ ...previous[0]!, line: 10 }], ['gap: 8px'])).toEqual([]);
    const extra = [
      { line: 11, property: 'gap', value: '8px' },
      { line: 12, property: 'gap', value: '9px' },
    ];
    expect(newFixtureLiterals([...previous, ...extra], ['gap: 8px'])).toEqual(extra);
  });
});
