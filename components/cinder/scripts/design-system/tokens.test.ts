import { describe, expect, test } from 'bun:test';

import type { ComponentManifest } from './manifest.ts';
import {
  buildTokens,
  FAMILY_TOKEN_CAP,
  formatColor,
  formatNumber,
  type ResolvedContext,
  type ResolvedToken,
} from './tokens.ts';

function token(
  type: string,
  value: unknown,
  cssProperty: string,
  category: string,
  cssRecipe: string | null = null,
): ResolvedToken {
  return {
    $type: type,
    $value: value,
    $description: `${cssProperty} description.`,
    $extensions: { 'com.lostgradient.cinder': { cssProperty, category, cssRecipe } },
  };
}

const manifest: ComponentManifest = {
  package: { tokenNamespaces: ['space', 'font', 'type-role', 'widget-extra'] },
  categories: {},
  components: [
    {
      id: 'button',
      exportName: 'Button',
      import: '@lostgradient/cinder',
      category: 'action',
      status: 'stable',
      purpose: 'Button.',
    },
  ],
};

const fonts: ResolvedContext = {
  'font.sans': token('fontFamily', ['system-ui', 'Segoe UI'], '--cinder-font-sans', 'typography'),
  'font.mono': token('fontFamily', ['ui-monospace'], '--cinder-font-mono', 'typography'),
};

function build(light: ResolvedContext, dark: ResolvedContext = light) {
  return buildTokens({
    light: { ...fonts, ...light },
    dark: { ...fonts, ...dark },
    manifest,
    sha: 'abc123',
    synced: '2026-11-09',
  });
}

describe('formatNumber', () => {
  test('trims to at most four decimals and writes negative zero as 0', () => {
    expect(formatNumber(2)).toBe('2');
    expect(formatNumber(0.5)).toBe('0.5');
    expect(formatNumber(1 / 3)).toBe('0.3333');
    expect(formatNumber(-0.00001)).toBe('0');
  });

  test('rounds an exact tie to even, as the original generator did', () => {
    expect(formatNumber(0.03125)).toBe('0.0312');
    expect(formatNumber(-0.03125)).toBe('-0.0312');
    expect(formatNumber(0.09375)).toBe('0.0938');
  });
});

describe('formatColor', () => {
  test('writes OKLCH with lightness as a percentage and alpha only when translucent', () => {
    expect(formatColor({ colorSpace: 'oklch', components: [0.5, 0.1, 270] })).toBe(
      'oklch(50% 0.1 270)',
    );
    expect(formatColor({ colorSpace: 'oklch', components: [0.5, 0.1, 270], alpha: 0.4 })).toBe(
      'oklch(50% 0.1 270 / 0.4)',
    );
    expect(formatColor({ colorSpace: 'srgb', components: [1, 0, 0.5] })).toBe('rgb(255 0 127.5)');
  });

  test('rejects a colour space or component it cannot write', () => {
    expect(() => formatColor({ colorSpace: 'hsl', components: [1, 0, 0] })).toThrow(
      'unsupported colour space',
    );
    expect(() => formatColor({ colorSpace: 'oklch', components: ['none', 0, 0] })).toThrow(
      'not a number',
    );
  });
});

describe('buildTokens', () => {
  test('routes tokens to families and keeps colours per theme', () => {
    const result = build(
      {
        'space.2': token('dimension', { value: 0.5, unit: 'rem' }, '--cinder-space-2', 'spacing'),
        'button.height': token(
          'dimension',
          { value: 2, unit: 'rem' },
          '--cinder-button-height',
          'size',
        ),
        'widget-extra.gap': token(
          'dimension',
          { value: 0, unit: 'px' },
          '--cinder-widget-gap',
          'spacing',
        ),
        'surface.canvas': token(
          'color',
          { colorSpace: 'oklch', components: [1, 0, 0] },
          '--cinder-surface-canvas',
          'color',
        ),
      },
      {
        'surface.canvas': token(
          'color',
          { colorSpace: 'oklch', components: [0.2, 0, 0] },
          '--cinder-surface-canvas',
          'color',
        ),
      },
    );
    const document = result.document as Record<string, { tokens: Array<{ name: string }> }>;
    expect(document['spacing']?.tokens.map((entry) => entry.name)).toEqual(['cinder-space-2']);
    expect(document['componentSizing']?.tokens.map((entry) => entry.name)).toEqual([
      'cinder-button-height',
    ]);
    expect(document['componentSpacing']?.tokens.map((entry) => entry.name)).toEqual([
      'cinder-widget-gap',
    ]);
    expect(document['color']?.tokens as unknown[]).toEqual([
      {
        name: 'cinder-surface-canvas',
        usage: '--cinder-surface-canvas description.',
        value: { light: 'oklch(100% 0 0)', dark: 'oklch(20% 0 0)' },
      },
    ]);
    // Four routed tokens and the two font families.
    expect(result.count).toBe(6);
    expect(result.css).toContain(
      '[data-theme="dark"] {\n  --cinder-surface-canvas: oklch(20% 0 0);',
    );
    expect(result.css).toContain('  --cinder-widget-gap: 0;');
    expect(result.css).toContain('  --font-sans: system-ui, "Segoe UI";');
    expect(result.css.startsWith('/* Cinder')).toBe(true);
  });

  test('uses a plain cssRecipe and reports a token it cannot place', () => {
    const result = build({
      'space.gutter': token(
        'dimension',
        { value: 1, unit: 'rem' },
        '--cinder-space-gutter',
        'spacing',
        'clamp(1rem, 2vw, 2rem)',
      ),
      'space.fixed': token(
        'dimension',
        { value: 1, unit: 'rem' },
        '--cinder-space-fixed',
        'spacing',
        '12px',
      ),
      'space.odd': token('dimension', { value: 1, unit: 'rem' }, '--cinder-space-odd', 'mystery'),
    });
    const spacing = (result.document['spacing'] as { tokens: Array<{ value: string }> }).tokens;
    expect(spacing.map((entry) => entry.value)).toEqual(['1rem', '12px']);
    expect(result.skipped).toEqual(['space.odd: no family for category mystery']);
  });

  test('fails on a family over the cap and on a duplicate name', () => {
    const many: ResolvedContext = {};
    for (let index = 0; index <= FAMILY_TOKEN_CAP; index += 1) {
      many[`space.${index}x`] = token(
        'dimension',
        { value: index, unit: 'px' },
        `--cinder-space-${index}x`,
        'spacing',
      );
    }
    expect(() => build(many)).toThrow(`spacing has ${FAMILY_TOKEN_CAP + 1} tokens`);
    expect(() =>
      build({
        'space.a': token('dimension', { value: 1, unit: 'px' }, '--cinder-twin', 'spacing'),
        'radius.a': token('dimension', { value: 1, unit: 'px' }, '--cinder-twin', 'radius'),
      }),
    ).toThrow('duplicate token names: cinder-twin');
  });
});
