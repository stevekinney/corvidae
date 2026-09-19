import { describe, expect, test } from 'bun:test';
import { buildTokensBaseCss } from './css-generator.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';
import { serializeTypedValue } from './value-formatters.ts';
function overrideResolverFixture() {
  // A base "lightness" token and a base "composite" color whose lightness component is a
  // NESTED reference (not a whole-token alias) to it. The dark theme context overrides BOTH
  // "lightness" (to a different value) AND "composite" (with the identical nested reference)
  // -- so a correct per-context resolver must resolve "composite"'s reference against dark's
  // own "lightness" override, not the base/foundation value.
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
  const themeLightDocument: TokenDocument = {};
  const themeDarkDocument: TokenDocument = {
    test: {
      lightness: { $type: 'number', $value: 0.8 },
      composite: {
        $type: 'color',
        $value: { colorSpace: 'oklch', components: ['{test.lightness}', 0.1, 250] },
      },
    },
  };
  const motionDefaultDocument: TokenDocument = {};

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
    ['motion-reduced.json', motionDefaultDocument],
    ['motion-forced.json', motionDefaultDocument],
  ]);

  return { resolver, documentsByPath };
}

function extendsFixture() {
  const baseDocument: TokenDocument = {
    foundation: {
      $type: 'color',
      swatch: {
        $value: { colorSpace: 'oklch', components: [0.4, 0.08, 200] },
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-inherited-swatch' } },
      },
    },
    themed: {
      // No own $type -- must inherit "color" from the extended group once $extends expands.
      $extends: '{foundation}',
      accent: {
        $value: { colorSpace: 'oklch', components: [0.6, 0.12, 20] },
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-local-accent' } },
      },
      // "swatch" is deliberately NOT redefined here -- it must be inherited from "foundation".
    },
  };
  const themeLightDocument: TokenDocument = {};
  const themeDarkDocument: TokenDocument = {};
  const motionDefaultDocument: TokenDocument = {};

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
    ['motion-reduced.json', motionDefaultDocument],
    ['motion-forced.json', motionDefaultDocument],
  ]);

  return { resolver, documentsByPath };
}

function extendsAcrossDocumentsFixture() {
  const baseDocument: TokenDocument = {
    palette: {
      $type: 'color',
      accent: {
        $value: { colorSpace: 'oklch', components: [0.4, 0.08, 200] },
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-palette-accent' } },
      },
    },
    'alt-palette': {
      $type: 'color',
      accent: {
        $value: { colorSpace: 'oklch', components: [0.7, 0.15, 30] },
        $extensions: { 'com.lostgradient.cinder': { cssProperty: '--test-alt-palette-accent' } },
      },
    },
  };
  const themeLightDocument: TokenDocument = {};
  // Dark's own group is named "palette" -- matching foundation's own token path, so
  // `renderOverrideDeclarations` finds foundation's cssProperty for it -- but `$extends` a
  // DIFFERENT foundation group, "alt-palette". Naming it after its OWN group would make the
  // `$extends` lookup find dark's own (still-expanding) group and report a circular reference
  // instead of exercising the cross-document lookup this test is about.
  const themeDarkDocument: TokenDocument = {
    palette: { $extends: '{alt-palette}' },
  };
  const motionDefaultDocument: TokenDocument = {};

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
    ['motion-reduced.json', motionDefaultDocument],
    ['motion-forced.json', motionDefaultDocument],
  ]);

  return { resolver, documentsByPath };
}

describe('E1: a nested reference inside an override context resolves against that context, not just the base', () => {
  test('the dark block resolves the nested reference against the dark override, not the base value', async () => {
    const { resolver, documentsByPath } = overrideResolverFixture();
    const css = await buildTokensBaseCss(resolver, documentsByPath);

    // Theme-specific motion blocks also contain `[data-theme='dark']`; select the block
    // that owns the theme override rather than relying on a fixed number of matches.
    const darkBlocks = [...css.matchAll(/\[data-theme='dark'\]\s*\{([^}]*)\}/g)];
    const darkBlock = darkBlocks.find((match) => match[1]?.includes('--test-composite'))?.[1];
    expect(darkBlock).toBeDefined();

    // Pre-fix, a resolver shared across all contexts and built from `baseDocuments` alone
    // resolves `{test.lightness}` to the BASE value (0.3 -> 30%) even inside the dark block.
    // Post-fix, it must resolve to dark's own override (0.8 -> 80%).
    expect(darkBlock).toContain('--test-composite: oklch(80% 0.1 250);');
    expect(darkBlock).not.toContain('30%');
  });
});

describe('E2: CSS-wide keywords are quoted in font-family output instead of emitted bare', () => {
  test('"inherit" as a font-family name is quoted, not emitted as the bare cascade keyword', () => {
    // Pre-fix, `inherit` matches SAFE_UNQUOTED_FONT_FAMILY_NAME (it's a valid bare
    // <custom-ident>) and is emitted bare -- which invokes CSS's `inherit` cascade behavior
    // instead of naming a font called "inherit".
    expect(serializeTypedValue('fontFamily', ['inherit'], 'test.font')).toBe("'inherit'");
  });

  test('every CSS-wide keyword is quoted, checked case-insensitively', () => {
    // "Unset" and "REVERT" prove the check is case-insensitive -- the keyword is matched
    // regardless of casing, but the ORIGINAL casing is preserved inside the quotes.
    for (const keyword of ['initial', 'Unset', 'REVERT', 'revert-layer']) {
      expect(serializeTypedValue('fontFamily', [keyword], 'test.font')).toBe(`'${keyword}'`);
    }
  });

  test('generic-family keywords stay bare (regression)', () => {
    expect(serializeTypedValue('fontFamily', ['sans-serif'], 'test.font')).toBe('sans-serif');
    expect(serializeTypedValue('fontFamily', ['system-ui'], 'test.font')).toBe('system-ui');
  });

  test('an ordinary safe identifier stays bare (regression)', () => {
    expect(serializeTypedValue('fontFamily', ['Roboto'], 'test.font')).toBe('Roboto');
  });
});

describe('E3: $extends group inheritance is applied before entries are collected', () => {
  test('a locally overridden member gets the extended $type, and an inherited member is emitted', async () => {
    const { resolver, documentsByPath } = extendsFixture();
    const css = await buildTokensBaseCss(resolver, documentsByPath);

    const rootBlock = /:root\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rootBlock).toBeDefined();

    // The locally-defined "accent" member has no own $type -- pre-fix, "themed" never gets
    // $extends applied, so its $type stays undefined, and generation throws before this
    // declaration is ever produced. Post-fix it resolves the inherited "color" $type and
    // serializes normally.
    expect(rootBlock).toContain('--test-local-accent: oklch(60% 0.12 20);');

    // "swatch" is never redefined under "themed" -- pre-fix it is absent from the output
    // entirely (only reachable via the un-expanded "foundation" path). Post-fix, $extends
    // copies it in, so the SAME value is now reachable under BOTH the "foundation" origin
    // token and the "themed" group that inherited it.
    const swatchDeclarationCount = (
      rootBlock!.match(/--test-inherited-swatch: oklch\(40% 0\.08 200\);/g) ?? []
    ).length;
    expect(swatchDeclarationCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the follow-up CIN-29 review round: two defects
// introduced by the E1/E3 fixes above (each context composing its OWN
// documents in isolation, for BOTH $extends expansion and nested-reference
// resolution), plus one independent JSON-Pointer defect. None touch the real
// corpus under src/tokens/, so a fix here can never change what
// tokens:generate emits for the committed files.
// ---------------------------------------------------------------------------

describe("F1: an override context's $extends can reference a foundation group, not just its own document", () => {
  test("the dark block emits the extended group's member instead of generation throwing", async () => {
    const { resolver, documentsByPath } = extendsAcrossDocumentsFixture();
    const css = await buildTokensBaseCss(resolver, documentsByPath);

    const darkBlocks = [...css.matchAll(/\[data-theme='dark'\]\s*\{([^}]*)\}/g)];
    const darkBlock = darkBlocks.find((match) => match[1]?.includes('--test-palette-accent'))?.[1];
    expect(darkBlock).toBeDefined();

    // Dark's own "palette" group never defines "accent" itself -- it only reaches it through
    // `$extends: "{alt-palette}"`, a group that lives in the FOUNDATION document, not dark's own.
    // Pre-fix, dark's own document is expanded in isolation, so "alt-palette" is not a group
    // `$extends` can find there, and generation throws before this assertion is ever reached.
    expect(darkBlock).toContain('--test-palette-accent: oklch(70% 0.15 30);');
  });
});
