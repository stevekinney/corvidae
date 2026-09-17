import { describe, expect, test } from 'bun:test';
import { type CorpusEntry } from './corpus.ts';
import { buildTokensBaseCss } from './css-generator.ts';
import { type ValueResolver } from './resolve.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';
import { resolveAlias } from './value-color.ts';
import { serializeEntryValue } from './value-entry.ts';
function motionNestedReferenceFixture() {
  // A base "lightness" number and a base "composite" color whose lightness component is a
  // NESTED reference to it. The themes intentionally diverge so reduced-motion output must
  // preserve the OS-selected value when no explicit data-theme is present.
  const baseDocument: TokenDocument = {
    test: {
      lightness: {
        $type: 'number',
        $value: 0.3,
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-lightness' } },
      },
      composite: {
        $type: 'color',
        $value: { colorSpace: 'oklch', components: ['{test.lightness}', 0.1, 250] },
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-composite' } },
      },
    },
  };
  const themeLightDocument: TokenDocument = {
    test: { lightness: { $type: 'number', $value: 0.7 } },
  };
  const themeDarkDocument: TokenDocument = {
    test: { lightness: { $type: 'number', $value: 0.8 } },
  };
  const motionDefaultDocument: TokenDocument = {};
  // "reduced" overrides ONLY "composite" -- it deliberately does NOT redefine "lightness"
  // itself, so the nested `{test.lightness}` reference inside it can only resolve correctly by
  // seeing a THEME document too, not by the motion context redefining lightness on its own.
  const motionReducedDocument: TokenDocument = {
    test: {
      composite: {
        $type: 'color',
        $value: { colorSpace: 'oklch', components: ['{test.lightness}', 0.1, 250] },
      },
    },
  };
  const motionForcedDocument: TokenDocument = {};

  const resolver: ResolverDocument = {
    version: '2025.10',
    sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
    modifiers: {
      theme: {
        contexts: {
          light: [{ $ref: 'theme-light.json' }],
          dark: [{ $ref: 'theme-dark.json' }],
        },
        default: 'light',
      },
      motion: {
        contexts: {
          default: [{ $ref: 'motion-default.json' }],
          reduced: [{ $ref: 'motion-reduced.json' }],
          'forced-reduced-motion': [{ $ref: 'motion-forced.json' }],
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
    ['base.json', baseDocument],
    ['theme-light.json', themeLightDocument],
    ['theme-dark.json', themeDarkDocument],
    ['motion-default.json', motionDefaultDocument],
    ['motion-reduced.json', motionReducedDocument],
    ['motion-forced.json', motionForcedDocument],
  ]);

  return { resolver, documentsByPath };
}

function hairlineBaseIndex(): Map<string, CorpusEntry> {
  return new Map([
    [
      'dimension.hairline',
      {
        path: 'dimension.hairline',
        value: { value: 1, unit: 'px' },
        type: 'dimension',
        description: undefined,
        cssProperty: '--test-hairline',
        cssRecipe: undefined,
      },
    ],
  ]);
}

function rootBaseIndex(): Map<string, CorpusEntry> {
  return new Map([
    [
      'space',
      {
        path: 'space',
        value: { value: 4, unit: 'px' },
        type: 'dimension',
        description: undefined,
        cssProperty: '--test-space',
        cssRecipe: undefined,
      },
    ],
    [
      '',
      {
        path: '',
        value: { value: 0, unit: 'px' },
        type: 'dimension',
        description: undefined,
        cssProperty: '--test-root',
        cssRecipe: undefined,
      },
    ],
  ]);
}

const resolveReferences: ValueResolver = (raw) =>
  raw === '#/dimension/hairline/$value/value' ? 1 : raw;

describe('F2: a nested reference inside a motion override resolves against the theme context too, not just the base', () => {
  test('preserves system-dark reduced-motion values while explicit themes remain correct', async () => {
    const { resolver, documentsByPath } = motionNestedReferenceFixture();

    const css = await buildTokensBaseCss(resolver, documentsByPath);
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*:root:not\(\[data-theme\]\):not\(\[data-cinder-reduced-motion='false'\]\)/,
    );
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*:root\[data-reduced-motion='on'\]:not\(\[data-theme\]\)/,
    );
    expect(css).toContain('--test-composite: oklch(80% 0.1 250);');
    expect(css).toContain('--test-composite: oklch(70% 0.1 250);');
  });
});

describe('F3: a property-form JSON Pointer whose terminal segment is $value resolves like the whole-token alias it names', () => {
  test('resolveAlias strips a trailing $value segment before the baseIndex lookup', () => {
    // `resolve.test.ts`'s "resolves a property-level JSON Pointer reference into a composite
    // token value" case accepts exactly this shape (`#/dimension/hairline/$value`) as a
    // whole-token alias -- resolve.ts's own resolver special-cases a trailing `$value` segment
    // the same way `{dimension.hairline}` would resolve. Pre-fix, `tokenPathFromReference` dot-joins
    // every segment with no such special case, so the lookup below misses the token entirely.
    expect(resolveAlias('#/dimension/hairline/$value', hairlineBaseIndex())).toBe(
      'var(--test-hairline)',
    );
  });

  test('a curly alias ending in .$value is a literal dotted path, not the pointer special case', () => {
    // `{a.b.$value}` is not resolve.ts's pointer-form special case -- it is a literal dotted
    // path through the corpus (an actual property named "$value" would be pathological, but the
    // curly syntax has no notion of "the whole token" the way a trailing pointer segment does).
    // Stripping it here would make the generator accept a shape the validator does not, the same
    // class of generator/validator disagreement this fix exists to close. The path is looked up
    // as literally "dimension.hairline.$value", which this baseIndex does not contain, so this
    // still throws -- proving the fix is gated on `#/` pointer syntax, not a blanket strip.
    expect(() => resolveAlias('{dimension.hairline.$value}', hairlineBaseIndex())).toThrow(
      /does not resolve to a base token/,
    );
  });

  test('a terminal composite-member segment (not $value) is left to fail the lookup, not silently reinterpreted', () => {
    // `#/border/thin/width` names a PIECE of the "border.thin" token's value, not the whole
    // token -- resolveAlias only knows how to emit `var(--property)` for a whole-token identity,
    // so this deliberately still throws rather than being treated as an alias to "border.thin".
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'border.thin',
        {
          path: 'border.thin',
          value: { color: '#000', width: { value: 1, unit: 'px' }, style: 'solid' },
          type: 'border',
          description: undefined,
          cssProperty: '--test-border-thin',
          cssRecipe: undefined,
        },
      ],
    ]);
    expect(() => resolveAlias('#/border/thin/width', baseIndex)).toThrow(
      /does not resolve to a base token/,
    );
  });
});

describe('a $ref whole-token alias to a $root token normalizes like resolve.ts does', () => {
  test('#/group/$root resolves to the group\'s own baseIndex entry, not "group.$root"', () => {
    // `collectEntries` indexes a group's `$root` token at the group's OWN path
    // (`into.set(prefix, ...)`), not `prefix.$root` -- `tokenPathFromReference`'s
    // plain dot-join would otherwise look up the wrong key and throw.
    expect(resolveAlias('#/space/$root', rootBaseIndex())).toBe('var(--test-space)');
  });

  test('#/group/$root/$value resolves the same way, stripping both segments', () => {
    expect(resolveAlias('#/space/$root/$value', rootBaseIndex())).toBe('var(--test-space)');
  });

  test('a bare #/$root resolves to the document root token', () => {
    expect(resolveAlias('#/$root', rootBaseIndex())).toBe('var(--test-root)');
  });

  test('#/$root/$value resolves the same way', () => {
    expect(resolveAlias('#/$root/$value', rootBaseIndex())).toBe('var(--test-root)');
  });
});

describe('a property-level $ref falls through to typed serialization instead of throwing', () => {
  test('a $ref targeting a scalar member of another token serializes that resolved value, not var(...)', () => {
    // `$ref` is a generic JSON Pointer with no DTCG requirement that its
    // target be a whole token, unlike an ordinary bare-alias $value (which
    // this generator has always required to name a whole token). A property-
    // level $ref resolves fine at `tokens:validate` time but has no matching
    // baseIndex entry, so it must fall through to `serializeTypedValue`
    // (via `resolveReferences`) instead of throwing the way an ordinary
    // $value alias to a non-whole-token path still does.
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'dimension.hairline',
        {
          path: 'dimension.hairline',
          value: { value: 1, unit: 'px' },
          type: 'dimension',
          description: undefined,
          cssProperty: '--test-hairline',
          cssRecipe: undefined,
        },
      ],
      [
        'space.tight',
        {
          path: 'space.tight',
          value: '#/dimension/hairline/$value/value',
          type: 'number',
          description: undefined,
          cssProperty: '--test-tight',
          cssRecipe: undefined,
          isRefAlias: true,
        },
      ],
    ]);
    const entry = baseIndex.get('space.tight')!;
    expect(serializeEntryValue(entry, baseIndex, resolveReferences)).toBe('1');
  });

  test('an ordinary $value alias to a non-whole-token path still throws (unchanged, not loosened by the $ref fix)', () => {
    const baseIndex = new Map<string, CorpusEntry>([
      [
        'border.thin',
        {
          path: 'border.thin',
          value: { color: '#000', width: { value: 1, unit: 'px' }, style: 'solid' },
          type: 'border',
          description: undefined,
          cssProperty: '--test-border-thin',
          cssRecipe: undefined,
        },
      ],
      [
        'border.derived',
        {
          path: 'border.derived',
          value: '#/border/thin/width',
          type: 'dimension',
          description: undefined,
          cssProperty: '--test-derived',
          cssRecipe: undefined,
          isRefAlias: false,
        },
      ],
    ]);
    const entry = baseIndex.get('border.derived')!;
    expect(() => serializeEntryValue(entry, baseIndex)).toThrow(/does not resolve to a base token/);
  });
});
