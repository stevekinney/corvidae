import { throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { createValueResolver } from './resolve.ts';
import { buildResolvedContexts } from './resolved-contexts.ts';
import type { ResolverDocument, TokenDocument } from './types.ts';
import { serializeTypedValue } from './value-formatters.ts';
function layer(inset: unknown) {
  return {
    color: { colorSpace: 'oklch', components: [0, 0, 0] },
    offsetX: { value: 0, unit: 'px' },
    offsetY: { value: 1, unit: 'px' },
    blur: { value: 2, unit: 'px' },
    spread: { value: 0, unit: 'px' },
    inset,
  };
}

function thirdModifierFixture(density: { default?: string }) {
  const baseDocument: TokenDocument = { token: { $type: 'number', $value: 1 } };
  const themeDocument: TokenDocument = {};
  const motionDocument: TokenDocument = {};
  const densityCozyDocument: TokenDocument = { token: { $value: 2 } };
  const densityCompactDocument: TokenDocument = { token: { $value: 3 } };

  const resolver: ResolverDocument = {
    version: '2025.10',
    sets: { foundation: { sources: [{ $ref: 'base.json' }] } },
    modifiers: {
      theme: {
        contexts: { light: [{ $ref: 'theme.json' }], dark: [{ $ref: 'theme.json' }] },
        default: 'light',
      },
      motion: {
        contexts: { default: [{ $ref: 'motion.json' }], reduced: [{ $ref: 'motion.json' }] },
        default: 'default',
      },
      density: {
        contexts: {
          cozy: [{ $ref: 'density-cozy.json' }],
          compact: [{ $ref: 'density-compact.json' }],
        },
        ...(density.default !== undefined ? { default: density.default } : {}),
      },
    },
    resolutionOrder: [
      { $ref: '#/sets/foundation' },
      { $ref: '#/modifiers/theme' },
      { $ref: '#/modifiers/motion' },
      { $ref: '#/modifiers/density' },
    ],
  };
  const documentsByPath = new Map<string, TokenDocument>([
    ['base.json', baseDocument],
    ['theme.json', themeDocument],
    ['motion.json', motionDocument],
    ['density-cozy.json', densityCozyDocument],
    ['density-compact.json', densityCompactDocument],
  ]);
  return { resolver, documentsByPath };
}

describe('D1: an oklch alpha of "none" is emitted, not silently dropped', () => {
  test('alpha: "none" appears in the serialized oklch() value', () => {
    expect(
      serializeTypedValue(
        'color',
        { colorSpace: 'oklch', components: [0.5, 0.1, 250], alpha: 'none' },
        'test.color',
      ),
    ).toBe('oklch(50% 0.1 250 / none)');
  });

  test('a numeric alpha still serializes (regression)', () => {
    expect(
      serializeTypedValue(
        'color',
        { colorSpace: 'oklch', components: [0.5, 0.1, 250], alpha: 0.5 },
        'test.color',
      ),
    ).toBe('oklch(50% 0.1 250 / 0.5)');
  });

  test('an absent alpha still omits the alpha segment (regression)', () => {
    expect(
      serializeTypedValue(
        'color',
        { colorSpace: 'oklch', components: [0.5, 0.1, 250] },
        'test.color',
      ),
    ).toBe('oklch(50% 0.1 250)');
  });
});

describe('D2: isShadowLayerArray enforces inset is boolean when present, not merely truthy', () => {
  test('a non-boolean (string) inset throws instead of serializing the literal "inset" keyword', () => {
    // A truthy-but-non-boolean "inset" (e.g. authored as a string "true" by mistake) must be
    // rejected, not treated as truthy -- the old `layer.inset ? 'inset' : undefined` check in
    // formatShadow would otherwise silently accept it and emit the "inset" keyword.
    expect(() => serializeTypedValue('shadow', layer('true'), 'test.shadow')).toThrow();
  });

  test('inset: true still serializes the "inset" keyword (regression)', () => {
    expect(serializeTypedValue('shadow', layer(true), 'test.shadow')).toBe(
      'inset 0 1px 2px oklch(0% 0 0)',
    );
  });

  test('inset: false still omits the "inset" keyword (regression)', () => {
    expect(serializeTypedValue('shadow', layer(false), 'test.shadow')).toBe(
      '0 1px 2px oklch(0% 0 0)',
    );
  });

  test('an absent inset still omits the "inset" keyword (regression)', () => {
    const { inset: _inset, ...withoutInset } = layer(false);
    expect(serializeTypedValue('shadow', withoutInset, 'test.shadow')).toBe(
      '0 1px 2px oklch(0% 0 0)',
    );
  });
});

describe('D3: a resolved-context combo fills an unnamed modifier from its declared default', () => {
  test("a combo that does not name density resolves it from density's own declared default", async () => {
    const { resolver, documentsByPath } = thirdModifierFixture({ default: 'cozy' });

    const resolved = await buildResolvedContexts(resolver, documentsByPath);
    const lightJson = resolved.get('light');
    expect(lightJson).toBeDefined();
    const parsed = JSON.parse(lightJson!);

    // "density" isn't named by any RESOLVED_CONTEXT_COMBO -- its declared default ("cozy",
    // value 2) must be the one that wins over "compact" (value 3).
    expect(parsed['token']?.$value).toBe(2);
  });

  test('a combo that does not name density AND density has no declared default fails with a named error', async () => {
    const { resolver, documentsByPath } = thirdModifierFixture({});

    expect(await throwingRejectionOf(buildResolvedContexts(resolver, documentsByPath))).toThrow(
      /density/,
    );
  });
});

describe('D4: references nested inside a composite value are resolved, not serialized literally', () => {
  test('a shadow inset resolved via a JSON Pointer to false is NOT emitted as the "inset" keyword', () => {
    const document = {
      test: {
        'other-shadow': {
          $type: 'shadow',
          $value: {
            color: { colorSpace: 'oklch', components: [0, 0, 0] },
            offsetX: { value: 0, unit: 'px' },
            offsetY: { value: 0, unit: 'px' },
            blur: { value: 0, unit: 'px' },
            spread: { value: 0, unit: 'px' },
            inset: false,
          },
        },
        shadow: {
          $type: 'shadow',
          $value: {
            color: { colorSpace: 'oklch', components: [0, 0, 0] },
            offsetX: { value: 0, unit: 'px' },
            offsetY: { value: 1, unit: 'px' },
            blur: { value: 2, unit: 'px' },
            spread: { value: 0, unit: 'px' },
            // JSON Pointer into ANOTHER token's `inset` property -- not a whole-token alias,
            // so `serializeEntryValue`'s top-level `isAliasReference(entry.value)` check never
            // fires; this reference lives one level inside the composite.
            inset: '#/test/other-shadow/inset',
          },
        },
      },
    } satisfies TokenDocument;
    const resolver = createValueResolver([document]);
    const shadowValue = document.test.shadow.$value;

    const serialized = serializeTypedValue('shadow', shadowValue, 'test.shadow', resolver);

    // Pre-fix, the raw string "#/test/other-shadow/inset" is non-empty and therefore truthy,
    // so the old `layer.inset ? 'inset' : undefined` check would emit the "inset" keyword --
    // silently inverting a token that resolves to `false`.
    expect(serialized).not.toContain('inset');
    expect(serialized).toBe('0 1px 2px oklch(0% 0 0)');
  });

  test('a color component holding a reference resolves instead of being rejected', () => {
    const document = {
      test: {
        'lightness-value': { $type: 'number', $value: 0.6 },
        color: {
          $type: 'color',
          $value: { colorSpace: 'oklch', components: ['{test.lightness-value}', 0.1, 250] },
        },
      },
    } satisfies TokenDocument;
    const resolver = createValueResolver([document]);
    const colorValue = document.test.color.$value;

    // Pre-fix, isColorComponent rejects a reference string outright (it accepts only `number`
    // or `'none'`), so isColorValue returns false and this throws "not a valid color" even
    // though validate.ts's isReference check explicitly permits a reference at this position.
    const serialized = serializeTypedValue('color', colorValue, 'test.color', resolver);
    expect(serialized).toBe('oklch(60% 0.1 250)');
  });

  test('a border color reference resolves to the referenced color literal (covers a non-shadow, non-color composite member)', () => {
    const document = {
      test: {
        'border-color': {
          $type: 'color',
          $value: { colorSpace: 'oklch', components: [0.2, 0.05, 30] },
        },
        border: {
          $type: 'border',
          $value: {
            color: '{test.border-color}',
            width: { value: 1, unit: 'px' },
            style: 'solid',
          },
        },
      },
    } satisfies TokenDocument;
    const resolver = createValueResolver([document]);
    const borderValue = document.test.border.$value;

    // `border` has no direct CSS serialization in serializeTypedValue (it goes through
    // cssRecipe in the real corpus), but resolving its nested `color` reference is exactly the
    // same reference machinery -- assert on the resolver's output directly.
    expect(resolver(borderValue)).toEqual({
      color: { colorSpace: 'oklch', components: [0.2, 0.05, 30] },
      width: { value: 1, unit: 'px' },
      style: 'solid',
    });
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the three CIN-29 round-3 review findings.
// ---------------------------------------------------------------------------
