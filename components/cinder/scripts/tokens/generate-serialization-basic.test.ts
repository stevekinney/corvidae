import { describe, expect, test } from 'bun:test';
import { requireDocument } from '../../src/tokens/runtime/context-order.ts';
import { type CorpusEntry } from '../../src/tokens/runtime/corpus.ts';
import type { ResolverDocument, TokenDocument } from '../../src/tokens/runtime/types.ts';
import { resolveAlias } from '../../src/tokens/runtime/value-color.ts';
import { serializeEntryValue } from '../../src/tokens/runtime/value-entry.ts';
import { serializeTypedValue } from '../../src/tokens/runtime/value-formatters.ts';
import { buildTokensBaseCss } from './css-generator.ts';
import { colorEntry } from './generator-test-support.ts';
describe('B1: #/ JSON Pointer aliases resolve like {curly} aliases', () => {
  test('a $value: "#/a/b" alias emits var(...) against the target cssProperty', () => {
    const baseIndex = new Map<string, CorpusEntry>([
      ['accent.background', colorEntry({ path: 'accent.background' })],
    ]);
    const pointerEntry: CorpusEntry = {
      path: 'accent.alias',
      value: '#/accent/background',
      type: undefined,
      description: undefined,
      cssProperty: '--test-alias',
      cssRecipe: undefined,
    };
    const curlyEntry: CorpusEntry = { ...pointerEntry, value: '{accent.background}' };

    expect(serializeEntryValue(pointerEntry, baseIndex)).toBe('var(--test-color)');
    expect(serializeEntryValue(curlyEntry, baseIndex)).toBe(
      serializeEntryValue(pointerEntry, baseIndex),
    );
  });

  test('resolveAlias decodes JSON Pointer percent- and tilde-escapes', () => {
    const baseIndex = new Map<string, CorpusEntry>([['a/b', colorEntry({ path: 'a/b' })]]);
    expect(resolveAlias('#/a~1b', baseIndex)).toBe('var(--test-color)');
  });
});

describe('B2: a single shadow object is accepted, not only an array of layers', () => {
  test('a bare shadow object normalizes to the same output as a one-element array', () => {
    const layer = {
      color: { colorSpace: 'oklch', components: [0, 0, 0], alpha: 0.2 },
      offsetX: { value: 0, unit: 'px' },
      offsetY: { value: 1, unit: 'px' },
      blur: { value: 2, unit: 'px' },
      spread: { value: 0, unit: 'px' },
    };

    expect(serializeTypedValue('shadow', layer, 'test.shadow')).toBe(
      serializeTypedValue('shadow', [layer], 'test.shadow'),
    );
    expect(serializeTypedValue('shadow', layer, 'test.shadow')).toBe(
      '0 1px 2px oklch(0% 0 0 / 0.2)',
    );
  });
});

describe('B3: named DTCG font weights are accepted and translated to CSS numbers', () => {
  test('every named weight maps to its OpenType usWeightClass number', () => {
    const expected: Record<string, string> = {
      thin: '100',
      'extra-light': '200',
      light: '300',
      normal: '400',
      medium: '500',
      'semi-bold': '600',
      bold: '700',
      'extra-bold': '800',
      black: '900',
      'extra-black': '950',
    };
    for (const [name, weight] of Object.entries(expected))
      expect(serializeTypedValue('fontWeight', name, 'test.weight')).toBe(weight);
  });

  test('a numeric fontWeight still passes through unchanged', () => {
    expect(serializeTypedValue('fontWeight', 600, 'test.weight')).toBe('600');
  });

  test('an unrecognized fontWeight name is rejected', () => {
    expect(() => serializeTypedValue('fontWeight', 'ultra-bold', 'test.weight')).toThrow();
  });
});

describe('B4: resolver source refs are normalized before document lookup', () => {
  test('a "./"-prefixed ref resolves to the same document as its normalized form', () => {
    const document: TokenDocument = {};
    const documentsByPath = new Map<string, TokenDocument>([
      ['sets/foundation.tokens.json', document],
    ]);

    expect(requireDocument(documentsByPath, './sets/foundation.tokens.json')).toBe(document);
    expect(requireDocument(documentsByPath, 'sets/./foundation.tokens.json')).toBe(document);
  });
});

describe('CIN-464 review: buildTokensBaseCss expands resolver-internal set references', () => {
  // Regression: `buildTokensBaseCss` built `lightDocuments`/`darkDocuments`
  // and both motion override document lists straight from
  // `themeModifier.contexts[...]`/`motionModifier.contexts[...]` via
  // `refsFor`, bypassing the same `#/sets/<name>` expansion
  // `validate-corpus.ts`'s `sourcesForEntry` already applies for the
  // equivalent resolution-order walk (used just below, for `*ScopeDocuments`,
  // via `documentsForResolutionOrder`). A theme or motion context that
  // referenced a set reached `requireDocument`, which looks for an on-disk
  // document literally named `#/sets/<name>` and throws -- a resolver
  // `tokens:validate` already accepted could not be generated.
  test('a theme context referencing a set via #/sets/<name> does not throw', async () => {
    const resolver: ResolverDocument = {
      version: '2025.10',
      sets: {
        foundation: { sources: [{ $ref: 'base.json' }] },
        lightOverrides: { sources: [{ $ref: 'light.json' }] },
      },
      modifiers: {
        theme: {
          contexts: {
            light: [{ $ref: '#/sets/lightOverrides' }],
            dark: [{ $ref: 'dark.json' }],
          },
          default: 'light',
        },
        motion: {
          contexts: {
            default: [{ $ref: 'motion-default.json' }],
            reduced: [{ $ref: 'motion-default.json' }],
            'forced-reduced-motion': [{ $ref: 'motion-default.json' }],
          },
          default: 'default',
        },
      },
      resolutionOrder: [
        { $ref: '#/sets/foundation' },
        { $ref: '#/modifiers/theme' },
        { $ref: '#/modifiers/motion' },
      ],
    };
    const documentsByPath = new Map<string, TokenDocument>([
      [
        'base.json',
        {
          color: {
            $type: 'color',
            $value: { colorSpace: 'srgb', components: [0, 0, 0] },
            $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-color' } },
          },
        },
      ],
      [
        'light.json',
        { color: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1, 1] } } },
      ],
      ['dark.json', {}],
      ['motion-default.json', {}],
    ]);

    const css = await buildTokensBaseCss(resolver, documentsByPath);
    expect(css).toContain('--cinder-color');
  });
});

describe('C1: isColorValue rejects a malformed color shape instead of serializing NaN%', () => {
  test('a components array with the wrong length throws', () => {
    expect(() =>
      serializeTypedValue('color', { colorSpace: 'oklch', components: [0.5, 0.1] }, 'test.color'),
    ).toThrow();
  });

  test('a non-numeric, non-"none" component throws', () => {
    expect(() =>
      serializeTypedValue(
        'color',
        { colorSpace: 'oklch', components: [0.5, 'bogus', 250] },
        'test.color',
      ),
    ).toThrow();
  });

  test('a well-formed color value still serializes (regression)', () => {
    expect(
      serializeTypedValue(
        'color',
        { colorSpace: 'oklch', components: [0.5, 0.1, 250] },
        'test.color',
      ),
    ).toBe('oklch(50% 0.1 250)');
  });
});

describe('C2: isCubicBezierValue requires exactly four numbers', () => {
  test('a three-number array throws instead of emitting an invalid cubic-bezier()', () => {
    expect(() => serializeTypedValue('cubicBezier', [0, 0, 0], 'test.ease')).toThrow();
  });

  test('a five-number array also throws', () => {
    expect(() => serializeTypedValue('cubicBezier', [0, 0, 0, 1, 2], 'test.ease')).toThrow();
  });

  test('a well-formed four-number array still serializes (regression)', () => {
    expect(serializeTypedValue('cubicBezier', [0.2, 0, 0, 1], 'test.ease')).toBe(
      'cubic-bezier(0.2, 0, 0, 1)',
    );
  });
});

describe('A3: a non-opaque srgb color is not silently flattened to an opaque hex', () => {
  test('alpha !== 1 falls back to the color() component form instead of dropping alpha through hex', () => {
    const serialized = serializeTypedValue(
      'color',
      { colorSpace: 'srgb', components: [1, 0, 0], hex: '#ff0000', alpha: 0.4 },
      'test.color',
    );
    expect(serialized).toBe('color(srgb 1 0 0 / 0.4)');
    expect(serialized).not.toContain('#ff0000');
  });

  test('alpha === 1 or absent still collapses to hex (regression)', () => {
    expect(
      serializeTypedValue(
        'color',
        { colorSpace: 'srgb', components: [1, 1, 1], hex: '#ffffff' },
        'test.color',
      ),
    ).toBe('#fff');
    expect(
      serializeTypedValue(
        'color',
        { colorSpace: 'srgb', components: [1, 1, 1], hex: '#ffffff', alpha: 1 },
        'test.color',
      ),
    ).toBe('#fff');
  });

  test('alpha === 0 still collapses to the transparent keyword (regression)', () => {
    expect(
      serializeTypedValue(
        'color',
        { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0 },
        'test.color',
      ),
    ).toBe('transparent');
  });
});

describe('A4: font-family names requiring escaping are quoted, not emitted bare', () => {
  test('a comma-containing name with no space is quoted so it does not parse as two families', () => {
    // No space in "Acme,Sans" -- the old `name.includes(' ')` check would
    // leave this bare, which the CSS parser reads as TWO family names
    // ("Acme" and "Sans") instead of one.
    expect(serializeTypedValue('fontFamily', ['Acme,Sans', 'sans-serif'], 'test.font')).toBe(
      "'Acme,Sans', sans-serif",
    );
  });

  test('the finding\'s own example ("ACME, Inc") is quoted', () => {
    expect(serializeTypedValue('fontFamily', ['ACME, Inc', 'sans-serif'], 'test.font')).toBe(
      "'ACME, Inc', sans-serif",
    );
  });

  test('an apostrophe in a name is escaped inside the quoted string', () => {
    expect(serializeTypedValue('fontFamily', ["O'Reilly Sans"], 'test.font')).toBe(
      "'O\\'Reilly Sans'",
    );
  });

  test('space-containing names stay quoted and generic keywords stay bare (regression, matches committed output)', () => {
    expect(
      serializeTypedValue(
        'fontFamily',
        ['system-ui', '-apple-system', 'Segoe UI', 'Helvetica Neue', 'sans-serif'],
        'test.font',
      ),
    ).toBe("system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif");
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the five follow-on CIN-29 review findings.
// ---------------------------------------------------------------------------
