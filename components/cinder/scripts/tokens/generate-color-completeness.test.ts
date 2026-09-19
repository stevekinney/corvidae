import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type CorpusEntry } from './corpus.ts';
import { buildTokensBaseCss } from './css-generator.ts';
import { tokensBaseCssPath } from './generator-configuration.ts';
import { colorEntry } from './generator-test-support.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';
import { findBareColorComponents } from './value-color.ts';
import { serializeEntryValue } from './value-entry.ts';

type RegistryEntry = { cssProperty: string; category?: string };

function isRegistry(value: unknown): value is { entries: RegistryEntry[] } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('entries' in value) ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }
  return value.entries.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'cssProperty' in entry &&
      typeof entry.cssProperty === 'string' &&
      (!('category' in entry) || typeof entry.category === 'string'),
  );
}
/**
 * A token overridden in only ONE theme used to leave the other theme's block
 * with no declaration for it. Custom properties inherit as COMPUTED values, so
 * a nested island of that other theme does not fall back to the `:root`
 * `light-dark()` declaration -- the themed ancestor already substituted its own
 * arm, and the island inherits that substituted value.
 *
 * The real-corpus case was `--cinder-code-block-background`, overridden only in
 * `dark.tokens.json`: a `[data-theme='light']` island inside a dark ancestor
 * kept the dark `surface-inset` ground under github-light Shiki token colors.
 */
function themeExclusiveOverrideFixture(overrideIn: 'light' | 'dark') {
  const baseDocument: TokenDocument = {
    test: {
      raised: {
        $type: 'number',
        $value: 0.9,
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-raised' } },
      },
      inset: {
        $type: 'number',
        $value: 0.1,
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-inset' } },
      },
      // Aliases `test.raised`, but emits through a `light-dark()` recipe -- the
      // exact shape `code-block.background` has in the real corpus.
      surface: {
        $type: 'number',
        $value: '{test.raised}',
        $extensions: {
          'com.lostgradient.cinder': {
            cssProperty: '--test-surface',
            cssRecipe: 'light-dark(var(--test-raised), var(--test-inset))',
          },
        },
      },
    },
  };
  // Only ONE theme overrides `test.surface`; the other says nothing about it.
  const exclusiveOverride: TokenDocument = {
    test: { surface: { $type: 'number', $value: '{test.inset}' } },
  };

  const resolver: ResolverDocument = {
    version: '2025.10',
    sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
    modifiers: {
      theme: {
        contexts: { light: [{ $ref: 'theme-light.json' }], dark: [{ $ref: 'theme-dark.json' }] },
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
    ['theme-light.json', overrideIn === 'light' ? exclusiveOverride : {}],
    ['theme-dark.json', overrideIn === 'dark' ? exclusiveOverride : {}],
    ['motion-default.json', {}],
    ['motion-reduced.json', {}],
    ['motion-forced.json', {}],
  ]);
  return { resolver, documentsByPath };
}

/** The `[data-theme='<theme>']` block that actually carries the theme overrides. */
function themeBlock(css: string, theme: 'light' | 'dark'): string {
  const pattern = new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`, 'g');
  const block = [...css.matchAll(pattern)].find((match) => match[1]?.includes('--test-'))?.[1];
  expect(block, `expected a [data-theme='${theme}'] block declaring --test-*`).toBeDefined();
  if (block === undefined) throw new Error(`missing [data-theme='${theme}'] block`);
  return block;
}

function recipeEntry(cssRecipe: string, type: CorpusEntry['type'] = 'color'): CorpusEntry {
  return colorEntry({
    path: 'polarity.ink',
    cssProperty: '--cinder-polarity-ink',
    cssRecipe,
    type,
  });
}

describe('CIN-494: a theme-exclusive override still resets in the opposite theme block', () => {
  test('a dark-only override still leaves the light block a declaration to reset with', async () => {
    const { resolver, documentsByPath } = themeExclusiveOverrideFixture('dark');
    const css = await buildTokensBaseCss(resolver, documentsByPath);

    // The dark block pins its own override, as it always did.
    expect(themeBlock(css, 'dark')).toContain('--test-surface: var(--test-inset);');

    // Pre-fix, the light block declared nothing for `--test-surface`, so a light
    // island nested inside a dark ancestor inherited the dark computed value.
    // Post-fix it re-emits the `light-dark()` recipe, which self-resets under the
    // block's own `color-scheme: light`.
    expect(themeBlock(css, 'light')).toContain(
      '--test-surface: light-dark(var(--test-raised), var(--test-inset));',
    );
  });

  test('the reset is symmetric -- a light-only override reaches the dark block too', async () => {
    const { resolver, documentsByPath } = themeExclusiveOverrideFixture('light');
    const css = await buildTokensBaseCss(resolver, documentsByPath);

    expect(themeBlock(css, 'light')).toContain('--test-surface: var(--test-inset);');
    expect(themeBlock(css, 'dark')).toContain(
      '--test-surface: light-dark(var(--test-raised), var(--test-inset));',
    );
  });
});

// ---------------------------------------------------------------------------
// CIN-242: a public color token must resolve to a COMPLETE CSS color, never a
// bare OKLCH component triplet. A bare triplet assigned to a color property is
// an invalid declaration that the browser drops silently, so nothing
// downstream -- not the contrast gate, not a screenshot diff -- reports it.
// ---------------------------------------------------------------------------

describe('CIN-242: complete color values only', () => {
  test('rejects the bare-triplet polarity token the decision record rules out', () => {
    // The literal shape CIN-242's decision record names: a component triplet
    // per arm, meant to be stapled into `oklch(var(--token) / 0.4)` at a call
    // site. Deliberately substituted here so the gate is proven to fire.
    expect(() =>
      serializeEntryValue(recipeEntry('light-dark(100% 0 0, 0% 0 0)'), new Map()),
    ).toThrow(/bare component list rather than a complete CSS color/);
  });

  test('rejects a bare triplet in a single arm, and inside a color-mix argument', () => {
    expect(() =>
      serializeEntryValue(recipeEntry('light-dark(oklch(0% 0 0), 100% 0 0)'), new Map()),
    ).toThrow(/bare component list/);
    expect(() =>
      serializeEntryValue(recipeEntry('color-mix(in oklch, 0% 0 0, transparent 96%)'), new Map()),
    ).toThrow(/bare component list/);
  });

  test('accepts every complete-value shape the corpus actually ships', () => {
    const accepted = [
      'light-dark(oklch(0% 0 0), oklch(100% 0 0))',
      'color-mix(in oklch, var(--cinder-polarity-ink), transparent 96%)',
      'light-dark(transparent, var(--cinder-border-strong))',
      'oklch(from var(--cinder-accent-solid) 0.7 0.14 h)',
      // The status-tier recipe: a relative-color form whose own body is a bare
      // component list by design. Descending into it would be a false positive.
      'oklch( from color-mix(in oklch, var(--cinder-info), var(--cinder-surface) 36%) l min(c, 0.05) h )',
      '#fff',
      'currentColor',
    ];
    for (const recipe of accepted) {
      expect(serializeEntryValue(recipeEntry(recipe), new Map())).toBe(recipe);
    }
  });

  test('accepts a color-mix weight in any position, literal or computed', () => {
    // `color-mix()` takes a general `<percentage>`, and it may sit on either
    // side of the color. Stripping only a trailing literal read every other
    // spelling as a bare component list and failed generation on recipes the
    // browser accepts.
    const accepted = [
      'color-mix(in oklch, var(--cinder-border-ink) calc(var(--weight) * 1%), transparent)',
      'color-mix(in oklch, 30% var(--cinder-border-ink), transparent)',
      'color-mix(in oklch, light-dark(oklch(0% 0 0), oklch(100% 0 0)) 40%, transparent)',
      'color-mix(in oklch, var(--cinder-polarity-ink), transparent clamp(10%, 20%, 30%))',
      // A weight supplied straight through a custom property, with the color
      // spelled as a function rather than a `var()`. The grammar says a
      // two-token argument is `<color> <percentage>` in some order, so the
      // token that is not a complete color is the weight -- whatever it looks
      // like.
      'color-mix(in oklch, light-dark(oklch(0% 0 0), oklch(100% 0 0)) var(--weight), transparent)',
      'color-mix(in oklch, var(--cinder-border-ink) var(--weight), transparent)',
      'color-mix(in oklch, var(--weight) var(--cinder-border-ink), transparent)',
      // Weight FIRST, computed. The mirror of the case above, and the one that
      // hid a real bypass: a `calc()` weight in front of the color.
      'color-mix(in oklch, calc(var(--weight) * 1%) var(--cinder-border-ink), transparent)',
      'color-mix(in oklch, clamp(10%, 20%, 30%) var(--cinder-polarity-ink), transparent)',
      // A CSS `<percentage-token>` is a `<number-token>` and `%`, and a number
      // may be signed or carry an exponent. A digits-and-dots pattern rejects
      // three of these four.
      'color-mix(in oklch, var(--cinder-border-ink) +40%, transparent)',
      'color-mix(in oklch, var(--cinder-border-ink) -0%, transparent)',
      'color-mix(in oklch, var(--cinder-border-ink) .5%, transparent)',
      'color-mix(in oklch, var(--cinder-border-ink) 4e1%, transparent)',
      'color-mix(in oklch, +40% var(--cinder-border-ink), transparent)',
      // A `var()` weight whose FALLBACK is a percentage. Ambiguous as a bare
      // reference, unambiguous once the fallback is read -- and checking it as
      // a color position would descend into the fallback and report `40%`.
      'color-mix(in oklch, var(--weight, 40%) var(--cinder-border-ink), transparent)',
      'color-mix(in oklch, var(--cinder-border-ink) var(--weight, 40%), transparent)',
      'color-mix(in oklch, var(--w, calc(1% * 2)) var(--cinder-border-ink), transparent)',
      // A unitless numeric fallback is a valid scalar in a calc product.
      'color-mix(in oklch, var(--cinder-border-ink) calc(var(--weight, 2) * 1%), transparent)',
      'color-mix(in oklch, var(--cinder-border-ink) calc(var(--weight, 40%) * 2), transparent)',
      'color-mix(in oklch, var(--cinder-border-ink) calc(2 * var(--weight, 40%)), transparent)',
      'color-mix(in oklch, var(--cinder-border-ink) calc(2 * var(--weight, 2) * 1%), transparent)',
    ];
    for (const recipe of accepted) {
      expect(serializeEntryValue(recipeEntry(recipe), new Map())).toBe(recipe);
    }
  });

  test('a bare triplet in a var() fallback is caught', () => {
    // `var()`'s fallback sits in the same color position as the reference, so a
    // bare list there is the same silently-dropped declaration one level down --
    // it just waits for the variable to be unset. Any function the checker does
    // not recognise returns `undefined`, so `var()` was a way past the gate.
    for (const recipe of [
      'var(--x, 0% 0 0)',
      'var(--a, var(--b, 0% 0 0))',
      'light-dark(var(--a, 100% 0 0), oklch(0% 0 0))',
      'color-mix(in oklch, var(--ink, 0% 0 0), transparent 96%)',
    ]) {
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    }
  });

  test('rejects a dimension-valued var() fallback used as a percentage scalar', () => {
    expect(() =>
      serializeEntryValue(
        recipeEntry(
          'color-mix(in oklch, var(--cinder-border-ink) calc(var(--weight, 2px) * 1%), transparent)',
        ),
        new Map(),
      ),
    ).toThrow();
  });

  test('a percentage-valued var() weight does not shield a bare color', () => {
    // The weight is skipped, so the COLOR beside it still gets checked.
    expect(() =>
      serializeEntryValue(
        recipeEntry('color-mix(in oklch, var(--w, 40%) light-dark(100% 0 0, 0% 0 0), transparent)'),
        new Map(),
      ),
    ).toThrow(/bare component list/);
  });

  test('a complete var() fallback is still accepted', () => {
    for (const recipe of [
      // The shape the corpus actually ships, from `slider.css`.
      'var(--cinder-border, currentColor)',
      'var(--a, var(--b, oklch(0% 0 0)))',
      'var(--cinder-polarity-ink)',
    ]) {
      expect(serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toBe(recipe);
    }
  });

  test('still catches a bare triplet that carries a mix weight', () => {
    // The weight must not become a way to smuggle a component list past the
    // gate -- stripping it has to leave the triplet exposed, not consumed.
    expect(() =>
      serializeEntryValue(recipeEntry('color-mix(in oklch, 0% 0 0 40%, transparent)'), new Map()),
    ).toThrow(/bare component list/);
    expect(() =>
      serializeEntryValue(
        recipeEntry('color-mix(in oklch, 0% 0 0 calc(var(--weight) * 1%), transparent)'),
        new Map(),
      ),
    ).toThrow(/bare component list/);
    expect(() =>
      serializeEntryValue(
        recipeEntry('color-mix(in oklch, 0% 0 0 var(--weight), transparent)'),
        new Map(),
      ),
    ).toThrow(/bare component list/);
    // The bypass itself: a weight BEFORE the color meant the color was
    // discarded as the weight, so the triplet was never looked at. `calc()`
    // and `var()` both read as "a complete color" to the old discriminator,
    // because `findBareColorComponents` returns undefined for any function it
    // does not recognise.
    for (const weight of ['calc(var(--w) * 1%)', 'var(--weight)', '30%', '+40%', '4e1%']) {
      expect(
        () =>
          serializeEntryValue(
            recipeEntry(`color-mix(in oklch, ${weight} light-dark(100% 0 0, 0% 0 0), transparent)`),
            new Map(),
          ),
        `a ${weight} weight before the color must not hide the triplet`,
      ).toThrow(/bare component list/);
    }
  });

  test('leaves non-color tokens alone -- a shadow recipe is a component list by nature', () => {
    const shadow = '0 1px 2px light-dark(oklch(0% 0 0 / 0.1), oklch(100% 0 0 / 0.09))';
    expect(serializeEntryValue(recipeEntry(shadow, 'shadow'), new Map())).toBe(shadow);
  });

  test('every color declaration the corpus emits is already a complete value', async () => {
    // The gate above runs inside the generator, so this is the artifact-side
    // restatement: it reads the COMMITTED stylesheet and the COMMITTED
    // registry rather than regenerating either, and so also covers a hand-edit
    // or a bad merge. Which properties are colors comes from the registry's
    // own `category`, not from a name pattern -- a spacing or shadow value is
    // a component list by design and must not be flagged.
    const registry: unknown = JSON.parse(
      await Bun.file(
        join(import.meta.dir, '..', '..', 'src', 'tokens', 'registry.generated.json'),
      ).text(),
    );
    if (!isRegistry(registry)) throw new Error('registry has an invalid shape');
    const entries = registry.entries;
    const colorProperties = new Set(
      entries.filter((entry) => entry.category === 'color').map((entry) => entry.cssProperty),
    );
    expect(colorProperties.size).toBeGreaterThan(100);

    const css = await Bun.file(tokensBaseCssPath).text();
    const bare: string[] = [];
    for (const [, property = '', value = ''] of css.matchAll(
      /(--cinder-[a-z0-9-]+):\s*([^;]+);/g,
    )) {
      if (!colorProperties.has(property)) continue;
      if (findBareColorComponents(value) !== undefined) bare.push(`${property}: ${value.trim()}`);
    }
    expect(bare).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CIN-602: `findBareColorComponents` decides completeness from a PARSED value
// tree (`postcss-value-parser`), not a function-name allowlist matched
// against text. This describe block proves two things the CIN-242 suite
// above cannot: that an unrecognised function now fails CLOSED (the
// structural fix this ticket exists for), and that every one of the four
// named bypasses is exercised at EVERY color position a real recipe can put
// it in, not only the one position each bypass happened to be discovered in.
// ---------------------------------------------------------------------------
