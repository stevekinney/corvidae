/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { parse } from 'postcss';

import { setupHappyDom } from '@lostgradient/testing';

import { readRootTokenValues } from '../test/token-introspection.ts';

setupHappyDom();

// `svelte` must resolve to its client build, so the kit loads after the test preload's plugin.
const { mountPanel, PANEL_TOKEN_MAP } = await import('./index.ts');
const { default: PanelMountFixture } = await import('../test/fixtures/panel-mount-fixture.svelte');

const panelCss = await Bun.file(new URL('./panel.css', import.meta.url)).text();
const tokensBase = await Bun.file(new URL('../styles/tokens-base.css', import.meta.url)).text();
const baseValues = readRootTokenValues(tokensBase);

/** A value with whitespace around punctuation removed, so formatting never decides equality. */
function normalized(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();
}

/** The `--cinder-*` declarations of the panel stylesheet's unlayered `:root` rule, in order. */
function panelDeclarations(): Array<readonly [string, string]> {
  const declarations: Array<readonly [string, string]> = [];
  let rules = 0;
  parse(panelCss).walkRules((rule) => {
    rules += 1;
    expect(rule.selector).toBe(':root');
    expect(rule.parent?.type).toBe('root');
    rule.walkDecls((declaration) => {
      declarations.push([declaration.prop, declaration.value]);
    });
  });
  expect(rules).toBe(1);
  return declarations;
}

/**
 * Splits `var(<name>, <fallback>)` at its first comma into the variable and its fallback, or
 * `undefined` when the value is some other shape.
 */
function splitVariable(value: string): { name: string; fallback: string } | undefined {
  const match = /^var\(\s*(--[a-z0-9-]+)\s*,([\s\S]*)\)$/.exec(value.trim());
  return match === null ? undefined : { name: match[1]!, fallback: match[2]!.trim() };
}

/** Whether a Cinder token's authored value ends in a color, following `var()` aliases. */
function isColorValued(token: string, seen = new Set<string>()): boolean {
  const value = baseValues.get(token);
  if (value === undefined || seen.has(token)) return false;
  seen.add(token);
  if (/\b(?:oklch|oklab|rgb|hsl|color-mix|light-dark)\(|^transparent$|^#/.test(value)) return true;
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  return alias === null ? false : isColorValued(alias[1]!, seen);
}

describe('PANEL_TOKEN_MAP and the panel stylesheet', () => {
  const declarations = panelDeclarations();

  test('the stylesheet declares each mapped token once, in the map order, and nothing else', () => {
    expect(declarations.map(([property]) => property)).toEqual(
      PANEL_TOKEN_MAP.map(([, cinderToken]) => cinderToken),
    );
    expect(new Set(declarations.map(([property]) => property)).size).toBe(declarations.length);
  });

  test.each(PANEL_TOKEN_MAP.map((pair) => [...pair]))(
    '%s reads var(%s, <Cinder default>)',
    (specKey, cinderToken) => {
      const declared = declarations.find(([property]) => property === cinderToken);
      const split = splitVariable(declared![1]);
      expect(split?.name).toBe(specKey);
      const base = baseValues.get(cinderToken);
      expect(base).toBeDefined();
      expect(normalized(split!.fallback)).toBe(normalized(base!));
    },
  );

  test('every spec key is a distinct variable the MCP Apps spec names', () => {
    const keys = PANEL_TOKEN_MAP.map(([specKey]) => specKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^--(?:color|font|border)-[a-z0-9-]+$/);
  });

  test('a color slot fills a color token and never a size or a length', () => {
    for (const [specKey, cinderToken] of PANEL_TOKEN_MAP) {
      if (!specKey.startsWith('--color-')) continue;
      expect(isColorValued(cinderToken)).toBe(true);
    }
  });

  test('the info slots fill from the --cinder-status-info-* tokens', () => {
    const map = new Map<string, string>(PANEL_TOKEN_MAP);
    expect(map.get('--color-background-info')).toBe('--cinder-status-info-background');
    expect(map.get('--color-text-info')).toBe('--cinder-status-info-text');
    expect(map.get('--color-border-info')).toBe('--cinder-status-info-border');
    expect(map.has('--color-ring-info')).toBe(false);
  });
});

describe('mountPanel', () => {
  test('mounts into the document body by default and passes the props', () => {
    const exports = mountPanel(PanelMountFixture, { props: { label: 'Run inspector' } });
    expect(document.body.querySelector('[data-testid="panel-mount-fixture"]')?.textContent).toBe(
      'Run inspector',
    );
    expect(exports).toBeDefined();
  });

  test('mounts into the target it is given and nowhere else', () => {
    const target = document.createElement('section');
    document.body.append(target);
    mountPanel(PanelMountFixture, { target, props: { label: 'Pending review' } });
    expect(target.querySelector('[data-testid="panel-mount-fixture"]')?.textContent).toBe(
      'Pending review',
    );
  });

  test('mounts a component that takes no props', () => {
    const target = document.createElement('div');
    document.body.append(target);
    mountPanel(PanelMountFixture, { target });
    expect(target.textContent).toBe('Panel');
  });
});
