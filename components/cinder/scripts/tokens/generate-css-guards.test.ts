import { describe, expect, test } from 'bun:test';
import { type CorpusEntry } from './corpus.ts';
import { buildTokensBaseCss } from './css-generator.ts';
import { assertUniqueOverrideCssProperties } from './css-support.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';
const colorValue = (lightness: number) => ({
  colorSpace: 'oklch',
  components: [lightness, 0.1, 250],
});

function overrideEntry(path: string, value: number): CorpusEntry {
  return {
    path,
    value,
    type: 'number',
    description: undefined,
    // Deliberately undefined -- an override document typically restates only
    // `$value`, not the inherited `cssProperty` extension. The guard has to
    // resolve it from `baseIndex`, or every override entry is silently
    // skipped as property-less.
    cssProperty: undefined,
    cssRecipe: undefined,
  };
}

// The motion blocks apply regardless of which [data-theme] is active, so
// checking a motion override only against the light-defaulted scope can
// miss a conflict that only shows up combined with dark. Here "alias.a"
// is never touched by the reduced-motion override, so its effective
// value tracks whichever theme is active (0.5 light, 0.2 dark) -- and
// "swatch.a"'s motion override (0.5) agrees with LIGHT but silently
// diverges from DARK.
// theme.default is DARK here (schema-valid, if unusual) -- an earlier
// version of this fix wrongly assumed the default-filled scope was
// always "light" and only added an explicit "dark" counterpart to check
// alongside it, which would validate dark TWICE here and leave light
// entirely unchecked. Both theme scopes must be built explicitly by
// name, not by assuming which one the default happens to be.
describe('CIN-469 finding 3: the uniqueness guard runs per override block, not only on baseIndex', () => {
  test('two override entries sharing a base cssProperty with DIFFERENT override values are rejected', () => {
    const baseIndex = new Map<string, CorpusEntry>([
      ['swatch.a', { ...overrideEntry('swatch.a', 1), cssProperty: '--test-swatch' }],
      ['alias.a', { ...overrideEntry('alias.a', 1), cssProperty: '--test-swatch' }],
    ]);
    // `$extends` gave these two base paths the SAME cssProperty with IDENTICAL
    // base values -- assertUniqueCssProperties already lets that through (see
    // "G1: one cssProperty shared with an IDENTICAL value is allowed" above).
    // A theme override then explicitly diverges them.
    const darkOverrides = new Map<string, CorpusEntry>([
      ['swatch.a', overrideEntry('swatch.a', 2)],
      ['alias.a', overrideEntry('alias.a', 3)],
    ]);

    expect(() =>
      assertUniqueOverrideCssProperties(darkOverrides, baseIndex, baseIndex, 'theme.dark'),
    ).toThrow(/\[theme\.dark\].*--test-swatch is claimed with conflicting values/);
  });

  test('overriding only ONE of two cssProperty-sharing paths is still a conflict if the other keeps a different base value', () => {
    // "alias.a" is never restated in this context, so its effective value
    // stays at its BASE value (1) -- but "swatch.a" is overridden to 2. The
    // two paths sharing "--test-swatch" now genuinely disagree (1 vs 2), the
    // same class of artifact-disagreement bug this guard exists to catch,
    // just reached because one claimant was silently absent from the
    // override map rather than both being explicitly restated with
    // different values. Comparing only the paths PRESENT in `overrides`
    // would miss this -- the base claimant must be pulled in too.
    const baseIndex = new Map<string, CorpusEntry>([
      ['swatch.a', { ...overrideEntry('swatch.a', 1), cssProperty: '--test-swatch' }],
      ['alias.a', { ...overrideEntry('alias.a', 1), cssProperty: '--test-swatch' }],
    ]);
    const darkOverrides = new Map<string, CorpusEntry>([
      ['swatch.a', overrideEntry('swatch.a', 2)],
    ]);

    expect(() =>
      assertUniqueOverrideCssProperties(darkOverrides, baseIndex, baseIndex, 'theme.dark'),
    ).toThrow(
      /\[theme\.dark\].*--test-swatch is claimed with conflicting values by alias\.a, swatch\.a/,
    );
  });

  test("overriding only ONE of two cssProperty-sharing paths is fine when the override MATCHES the other one's base value", () => {
    // No genuine divergence here: "swatch.a" is overridden to 1, which is
    // exactly what "alias.a" (never restated in this context) already has
    // as its base value -- both paths agree on "--test-swatch" throughout
    // this context, so there is nothing to reject.
    const baseIndex = new Map<string, CorpusEntry>([
      ['swatch.a', { ...overrideEntry('swatch.a', 1), cssProperty: '--test-swatch' }],
      ['alias.a', { ...overrideEntry('alias.a', 1), cssProperty: '--test-swatch' }],
    ]);
    const darkOverrides = new Map<string, CorpusEntry>([
      ['swatch.a', overrideEntry('swatch.a', 1)],
    ]);

    expect(() =>
      assertUniqueOverrideCssProperties(darkOverrides, baseIndex, baseIndex, 'theme.dark'),
    ).not.toThrow();
  });

  test('a claimant already changed by an EARLIER modifier in the composed scope is compared against its scope value, not raw base', () => {
    // "swatch.a" and "alias.a" share a cssProperty at base value 1. The
    // THEME already changed BOTH to 2 (part of this block's composed
    // scope). MOTION's own override map here restates only "swatch.a",
    // changing it back to 1 -- "alias.a" is untouched by motion, so its
    // effective value in this scope is 2 (from theme), NOT its raw base
    // value of 1. Comparing against raw baseIndex would wrongly see 1 vs 1
    // (no conflict); the real combination disagrees (1 vs 2).
    const baseIndex = new Map<string, CorpusEntry>([
      ['swatch.a', { ...overrideEntry('swatch.a', 1), cssProperty: '--test-swatch' }],
      ['alias.a', { ...overrideEntry('alias.a', 1), cssProperty: '--test-swatch' }],
    ]);
    const themeComposedScope = new Map<string, CorpusEntry>([
      ['swatch.a', overrideEntry('swatch.a', 2)],
      ['alias.a', overrideEntry('alias.a', 2)],
    ]);
    const motionOverrides = new Map<string, CorpusEntry>([
      ['swatch.a', overrideEntry('swatch.a', 1)],
    ]);

    expect(() =>
      assertUniqueOverrideCssProperties(
        motionOverrides,
        baseIndex,
        themeComposedScope,
        'motion.reduced',
      ),
    ).toThrow(
      /\[motion\.reduced\].*--test-swatch is claimed with conflicting values by alias\.a, swatch\.a/,
    );
  });

  test('an override restating a DIFFERENT cssProperty than its base is still compared under the base property, matching emission', () => {
    // `renderOverrideDeclarations` always emits an override under its BASE
    // token's `cssProperty` -- it never honors a `cssProperty` an override
    // document happens to restate. Here "alias.a" restates "--test-other"
    // instead of its base "--test-swatch", but generation still writes it
    // to "--test-swatch". Grouping/resolving by the override's own restated
    // property would wrongly treat "alias.a" as claiming "--test-other" and
    // miss that it actually collides with "swatch.a" on "--test-swatch".
    const baseIndex = new Map<string, CorpusEntry>([
      ['swatch.a', { ...overrideEntry('swatch.a', 1), cssProperty: '--test-swatch' }],
      ['alias.a', { ...overrideEntry('alias.a', 1), cssProperty: '--test-swatch' }],
    ]);
    const darkOverrides = new Map<string, CorpusEntry>([
      ['alias.a', { ...overrideEntry('alias.a', 2), cssProperty: '--test-other' }],
    ]);

    expect(() =>
      assertUniqueOverrideCssProperties(darkOverrides, baseIndex, baseIndex, 'theme.dark'),
    ).toThrow(
      /\[theme\.dark\].*--test-swatch is claimed with conflicting values by alias\.a, swatch\.a/,
    );
  });

  test('the full buildTokensBaseCss pipeline rejects a theme override that diverges two $extends-shared paths', async () => {
    const baseDocument: TokenDocument = {
      swatch: {
        $type: 'color',
        a: {
          $value: colorValue(0.5),
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-shared-swatch' } },
        },
      },
      // No own "a" key: an EMPTY "a: {}" would itself be a (childless) token
      // GROUP, not an absent member, so `resolveExtends`'s "copy missing
      // members" branch would skip it (the group already "has" a, even though
      // it is empty) and `alias.a` would never inherit swatch.a's identity.
      alias: { $extends: '{swatch}' },
    };
    const themeDarkDocument: TokenDocument = {
      swatch: { a: { $value: colorValue(0.2) } },
      alias: { a: { $value: colorValue(0.9) } },
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
      ['base.json', baseDocument],
      ['theme-light.json', {}],
      ['theme-dark.json', themeDarkDocument],
      ['motion-default.json', {}],
    ]);

    expect(buildTokensBaseCss(resolver, documentsByPath)).rejects.toThrow(
      /\[theme\.dark\].*--test-shared-swatch is claimed with conflicting values/,
    );
  });

  test('a motion override that only agrees with LIGHT is still rejected -- dark+reduced is an equally reachable combination', async () => {
    const baseDocument: TokenDocument = {
      swatch: {
        $type: 'color',
        a: {
          $value: colorValue(0.5),
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-shared-swatch' } },
        },
      },
      alias: { $extends: '{swatch}' },
    };
    const themeDarkDocument: TokenDocument = {
      swatch: { $type: 'color', a: { $value: colorValue(0.2) } },
      alias: { $type: 'color', a: { $value: colorValue(0.2) } },
    };
    const motionReducedDocument: TokenDocument = {
      swatch: { $type: 'color', a: { $value: colorValue(0.5) } },
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
      ['base.json', baseDocument],
      ['theme-light.json', {}],
      ['theme-dark.json', themeDarkDocument],
      ['motion-default.json', {}],
      ['motion-reduced.json', motionReducedDocument],
    ]);

    expect(buildTokensBaseCss(resolver, documentsByPath)).rejects.toThrow(
      /\[motion\.reduced \(dark theme\)\].*--test-shared-swatch is claimed with conflicting values/,
    );
  });

  test('a motion override that only agrees with the non-default theme is still rejected -- neither theme scope is assumed to be "light"', async () => {
    const baseDocument: TokenDocument = {
      swatch: {
        $type: 'color',
        a: {
          $value: colorValue(0.5),
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-shared-swatch' } },
        },
      },
      alias: { $extends: '{swatch}' },
    };
    const themeLightDocument: TokenDocument = {
      swatch: { $type: 'color', a: { $value: colorValue(0.9) } },
      alias: { $type: 'color', a: { $value: colorValue(0.9) } },
    };
    const motionReducedDocument: TokenDocument = {
      swatch: { $type: 'color', a: { $value: colorValue(0.5) } },
    };
    const resolver: ResolverDocument = {
      version: '2025.10',
      sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
      modifiers: {
        theme: {
          contexts: { light: [{ $ref: 'theme-light.json' }], dark: [{ $ref: 'theme-dark.json' }] },
          default: 'dark',
        },
        motion: {
          contexts: {
            default: [{ $ref: 'motion-default.json' }],
            reduced: [{ $ref: 'motion-reduced.json' }],
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
      ['base.json', baseDocument],
      ['theme-light.json', themeLightDocument],
      ['theme-dark.json', {}],
      ['motion-default.json', {}],
      ['motion-reduced.json', motionReducedDocument],
    ]);

    expect(buildTokensBaseCss(resolver, documentsByPath)).rejects.toThrow(
      /\[motion\.reduced \(light theme\)\].*--test-shared-swatch is claimed with conflicting values/,
    );
  });
});
