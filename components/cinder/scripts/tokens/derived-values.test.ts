import { describe, expect, test } from 'bun:test';

import { materializeDerivedValues, rewriteSourceText } from './derived-values.ts';
import { loadCorpus } from './generate.ts';
import { evaluateRecipe, lightDarkArms, type Oklch } from './recipe-evaluator.ts';

const none = (): undefined => undefined;

function close(actual: Oklch | undefined, expected: Oklch): void {
  expect(actual).toBeDefined();
  expect(actual!.l).toBeCloseTo(expected.l, 4);
  expect(actual!.c).toBeCloseTo(expected.c, 4);
  if (expected.h === undefined) expect(actual!.h).toBeUndefined();
  else expect(actual!.h!).toBeCloseTo(expected.h, 3);
  expect(actual!.alpha).toBeCloseTo(expected.alpha, 4);
}

describe('recipe evaluator', () => {
  // Each expectation is what Chromium's `getComputedStyle` reports for the
  // same expression, so a materialized `$value` matches what actually renders.
  test('interpolates an explicit achromatic hue literally, as browsers do', () => {
    close(evaluateRecipe('color-mix(in oklch, oklch(28% 0.045 245), oklch(100% 0 0) 2.5%)', none), {
      l: 0.298,
      c: 0.043875,
      h: 247.875,
      alpha: 1,
    });
    close(evaluateRecipe('color-mix(in oklch, oklch(100% 0 255), oklch(50% 0.22 270) 6%)', none), {
      l: 0.97,
      c: 0.0132,
      h: 255.9,
      alpha: 1,
    });
  });

  test('mixing with transparent keeps the color and scales its alpha', () => {
    close(evaluateRecipe('color-mix(in oklch, oklch(20% 0.02 255), transparent 80%)', none), {
      l: 0.2,
      c: 0.02,
      h: 255,
      alpha: 0.2,
    });
  });

  test('relative colors apply calc() and min() to channels', () => {
    close(evaluateRecipe('oklch(from oklch(50% 0.22 270) calc(l - 0.08) c h)', none), {
      l: 0.42,
      c: 0.22,
      h: 270,
      alpha: 1,
    });
    close(evaluateRecipe('oklch(from oklch(50% 0.22 270) l min(c, 0.05) h)', none), {
      l: 0.5,
      c: 0.05,
      h: 270,
      alpha: 1,
    });
  });

  test('mixes in OKLab without travelling around the hue wheel', () => {
    // Chromium: oklab(0.6764 0.115728 0.0530519).
    const mixed = evaluateRecipe(
      'color-mix(in oklab, oklch(50% 0.2 25), oklch(99% 0.003 255) 36%)',
      none,
    );
    const radians = (mixed!.h! * Math.PI) / 180;
    expect(mixed!.l).toBeCloseTo(0.6764, 4);
    expect(mixed!.c * Math.cos(radians)).toBeCloseTo(0.115728, 4);
    expect(mixed!.c * Math.sin(radians)).toBeCloseTo(0.0530519, 4);
  });

  test('reads custom properties through the lookup', () => {
    const ink: Oklch = { l: 0.86, c: 0.065, h: 250, alpha: 1 };
    close(
      evaluateRecipe('color-mix(in oklch, var(--ink), transparent 52%)', (property) =>
        property === '--ink' ? ink : undefined,
      ),
      { ...ink, alpha: 0.48 },
    );
  });

  test('returns undefined for anything outside the grammar', () => {
    expect(evaluateRecipe('light-dark(red, blue)', none)).toBeUndefined();
    expect(evaluateRecipe('color-mix(in srgb, red, blue)', none)).toBeUndefined();
  });

  test('splits a top-level light-dark() into its arms', () => {
    expect(lightDarkArms('light-dark(oklch(from var(--a) 0.55 0.16 h), var(--b))')).toEqual({
      light: 'oklch(from var(--a) 0.55 0.16 h)',
      dark: 'var(--b)',
    });
    expect(lightDarkArms('var(--a)')).toBeUndefined();
  });
});

describe('derived value materialization', () => {
  test('the committed corpus already holds every materialized value', async () => {
    // `tokens:check` gates this too; asserting it here names the failure.
    const { documentsByPath, sourceDocumentsByPath } = await loadCorpus();
    const stale = [...documentsByPath]
      .filter(([path, document]) => document !== sourceDocumentsByPath.get(path))
      .map(([path]) => path);
    expect(stale, `run tokens:generate; these documents carry stale derived values`).toEqual([]);
  });

  test('a changed base input re-derives every theme entry that reads it', async () => {
    const { resolver, sourceDocumentsByPath } = await loadCorpus();
    const edited = new Map(sourceDocumentsByPath);
    const dark = structuredClone(edited.get('themes/dark.tokens.json')!) as Record<string, any>;
    dark['border']['ink']['$value'] = { colorSpace: 'oklch', components: [0.5, 0.1, 30] };
    edited.set('themes/dark.tokens.json', dark);

    const materialized = materializeDerivedValues(resolver, edited);
    const darkBorder = (materialized.get('themes/dark.tokens.json') as Record<string, any>)[
      'border'
    ];
    for (const tier of ['muted', 'strong']) {
      expect(darkBorder[tier]['$value']['components']).toEqual([0.5, 0.1, 30]);
    }
    // The light theme does not read the dark ink, so it is untouched.
    expect(materialized.get('themes/light.tokens.json')).toBe(
      sourceDocumentsByPath.get('themes/light.tokens.json'),
    );
  });

  test('a token that stops being derived loses the theme entries this step generated', async () => {
    const { resolver, sourceDocumentsByPath } = await loadCorpus();
    const edited = new Map(sourceDocumentsByPath);
    const semantic = structuredClone(edited.get('sets/semantic.tokens.json')!) as Record<
      string,
      any
    >;
    // A constant now: the recipe is gone, so the tier no longer reads the ink.
    delete semantic['border']['muted']['$extensions']['com.lostgradient.cinder']['cssRecipe'];
    edited.set('sets/semantic.tokens.json', semantic);

    const materialized = materializeDerivedValues(resolver, edited);
    for (const theme of ['light', 'dark']) {
      const border = (materialized.get(`themes/${theme}.tokens.json`) as Record<string, any>)[
        'border'
      ];
      expect(border['muted'], `${theme} keeps no stale border.muted override`).toBeUndefined();
      expect(border['strong'], `${theme} keeps the tiers that are still derived`).toBeDefined();
    }
  });

  test("a theme alias follows its base recipe's bare-variable arm", async () => {
    const { resolver, sourceDocumentsByPath } = await loadCorpus();
    const edited = new Map(sourceDocumentsByPath);
    const semantic = structuredClone(edited.get('sets/semantic.tokens.json')!) as Record<
      string,
      any
    >;
    const extension = semantic['surface']['inverse']['$extensions']['com.lostgradient.cinder'];
    extension['cssRecipe'] = 'light-dark(var(--cinder-text-default), var(--cinder-surface))';
    edited.set('sets/semantic.tokens.json', semantic);

    const materialized = materializeDerivedValues(resolver, edited);
    const dark = materialized.get('themes/dark.tokens.json') as Record<string, any>;
    expect(dark['surface']['inverse']).toEqual({ $value: '{surface.base}' });
  });

  test('a derived recipe outside the evaluator grammar fails generation', async () => {
    const { resolver, sourceDocumentsByPath } = await loadCorpus();
    const edited = new Map(sourceDocumentsByPath);
    const semantic = structuredClone(edited.get('sets/semantic.tokens.json')!) as Record<
      string,
      any
    >;
    semantic['border']['muted']['$extensions']['com.lostgradient.cinder']['cssRecipe'] =
      'color-mix(in srgb, var(--cinder-border-ink), transparent 90%)';
    edited.set('sets/semantic.tokens.json', semantic);

    expect(() => materializeDerivedValues(resolver, edited)).toThrow(
      'Cannot evaluate the derived recipe of "border.muted"',
    );
  });

  test('rewriting a source document removes tokens the materialized document dropped', () => {
    const text =
      '{\n  "border": {\n    "muted": { "$value": 1 },\n    "strong": { "$value": 2 }\n  },\n  "only": { "gone": { "$value": 3 } }\n}';
    const original = JSON.parse(text);
    const changed = { border: { strong: { $value: 2 } } };
    expect(JSON.parse(rewriteSourceText(text, original, changed))).toEqual(changed);
  });

  test('rewriting a source document keeps integer-like keys in place', () => {
    const text =
      '{\n  "series": {\n    "$type": "color",\n    "1": { "$value": 1 },\n    "x": { "$value": 2 }\n  }\n}';
    const original = JSON.parse(text);
    const changed = structuredClone(original);
    changed.series.x.$value = 3;
    expect(rewriteSourceText(text, original, changed)).toBe(
      JSON.stringify(
        { series: { $type: 'color', '#int#1': { $value: 1 }, x: { $value: 3 } } },
        null,
        2,
      ).replace('"#int#1"', '"1"'),
    );
  });
});
