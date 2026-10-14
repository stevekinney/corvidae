import { describe, expect, test } from 'bun:test';

import { CINDER_BASE } from './base-corpus.ts';
import { evaluateThemeProperties } from './evaluate.ts';
import { applyCssOnlyOverrides, buildThemeSources } from './theme-sources.ts';
import {
  renderThemeStylesheet,
  StylesheetError,
  type ContextProperties,
  type StylesheetContext,
} from './theme-stylesheet.ts';

const emptyOverrides = { shared: {}, light: {}, dark: {}, reduced: {}, forcedReduced: {} };
const envelope = { base: CINDER_BASE, overrides: emptyOverrides };

function evaluatedMaps(): ContextProperties {
  const result = evaluateThemeProperties(buildThemeSources(envelope, 1));
  if (!result.ok) throw new Error('the shipped base must evaluate');
  return result.properties as ContextProperties;
}

const maps = evaluatedMaps();
const css = renderThemeStylesheet(maps, { identity: 'test theme' });

function withValue(context: StylesheetContext, name: string, value: string): ContextProperties {
  return { ...maps, [context]: { ...maps[context], [name]: value } };
}

describe('buildThemeSources', () => {
  test('appends one override document per scope to the resolver without mutating the base', () => {
    const sources = buildThemeSources(envelope, 3);
    expect(sources.revision).toBe(3);
    expect(Object.keys(sources.documents)).toContain('overrides/forced-reduced-motion.tokens.json');
    expect(JSON.stringify(CINDER_BASE.resolver)).not.toContain('overrides/');
  });
});

describe('renderThemeStylesheet', () => {
  test('puts the whole theme in the named layer, ordered after every Cinder layer', () => {
    expect(css).toContain(
      '@layer cinder.tokens, cinder.foundation, cinder.components, cinder.utilities, cinder-theme;',
    );
    expect(css).toContain('@layer cinder-theme {');
    expect(css).toContain(' * test theme');
  });

  test('uses the generator skeleton: root and descendant theme scopes, media, forced motion', () => {
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toContain("[data-theme='light'] {");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(":root[data-reduced-motion='on'] {");
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  test('declares only public Cinder properties and no reset or component selector', () => {
    const properties = [...css.matchAll(/^\s+(--[\w-]+):/gm)].map((match) => match[1]);
    expect(properties.length).toBeGreaterThan(300);
    expect(properties.every((name) => name?.startsWith('--cinder-'))).toBe(true);
    const selectors = [...css.matchAll(/^([^\s@/*][^{\n]*)\{/gm)].map((match) => match[1] ?? '');
    expect(selectors.every((selector) => /^(:root|\[data-theme)/.test(selector.trim()))).toBe(
      true,
    );
  });

  test('restates a motion difference for the theme that changes it, and only there', () => {
    const lightOnly = withValue('light/reduced', '--cinder-radius-md', '9px');
    const output = renderThemeStylesheet(lightOnly);
    expect(output).toContain('--cinder-radius-md: 9px;');
    const darkRestates = renderThemeStylesheet(
      withValue('dark/default', '--cinder-radius-md', '3px'),
    );
    expect(darkRestates).toContain('--cinder-radius-md: 3px;');
  });

  test.each([
    ['a declaration terminator', 'red; --x: 1'],
    ['a closing brace', 'red}'],
    ['a comment', 'red /* x */'],
    ['a resource function', 'url(https://example.test/x.png)'],
    ['an escape', 'r\\65 d'],
    ['an important flag', 'red !important'],
    ['an empty value', '  '],
  ])('refuses %s', (_label, value) => {
    expect(() =>
      renderThemeStylesheet(withValue('light/default', '--cinder-radius-md', value)),
    ).toThrow(StylesheetError);
  });

  test('refuses a property outside the public Cinder surface', () => {
    expect(() => renderThemeStylesheet(withValue('light/default', '--_cinder-x', '1px'))).toThrow(
      StylesheetError,
    );
  });
});

describe('applyCssOnlyOverrides', () => {
  test('lays a context value over its public property and ignores unknown paths', () => {
    const merged = applyCssOnlyOverrides(
      { '--cinder-carousel-slide-size': '100%' },
      {
        'carousel.slide-size': { 'dark/default': '80%' },
        'not.a.token': { 'dark/default': '1px' },
      },
      'dark/default',
    );
    expect(merged).toEqual({ '--cinder-carousel-slide-size': '80%' });
  });

  test('skips a value the caller refuses', () => {
    const merged = applyCssOnlyOverrides(
      { '--cinder-carousel-slide-size': '100%' },
      { 'carousel.slide-size': { 'dark/default': '80%' } },
      'dark/default',
      () => false,
    );
    expect(merged['--cinder-carousel-slide-size']).toBe('100%');
  });
});
