import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  AGREED_LIGHT_SHADOWS,
  TOKEN_FILES,
  findBrightShadows,
  judgeShadowTokens,
} from './check-shadow-tokens';
import { repositoryRoot } from './owner-rule-guard-support';

const layer = (alpha: number, lightness = 0) => ({
  color: { colorSpace: 'oklch', components: [lightness, 0, 0], alpha },
});

describe('shadow tokens', () => {
  test('the real light and dark tokens pass', async () => {
    for (const file of TOKEN_FILES) {
      const theme = file.endsWith('light.json') ? 'light' : 'dark';
      const tokens = await Bun.file(join(repositoryRoot, file)).json();
      expect(judgeShadowTokens(theme, tokens)).toEqual([]);
    }
  });

  test('a light layer heavier than the agreed alpha fails', () => {
    const tokens = { 'shadow.small': { $value: [layer(0.1), layer(0.3)] } };
    expect(judgeShadowTokens('light', tokens)).toEqual([
      'light shadow.small - a layer of alpha 0.3 is heavier than the agreed 0.1',
    ]);
  });

  test('a light shadow token with no agreed ceiling fails', () => {
    const tokens = { 'panel.shadow-color': { $value: layer(0.05).color } };
    expect(judgeShadowTokens('light', tokens)[0]).toContain('no agreed ceiling');
  });

  test('a bright shadow colour fails in either theme', () => {
    const tokens = { 'shadow.small': { $value: [layer(0.05, 0.95)] } };
    expect(judgeShadowTokens('dark', tokens)[0]).toContain('not black');
    expect(judgeShadowTokens('light', tokens)[0]).toContain('not black');
  });

  test('a dark shadow is as dense as it likes, and every agreed token is a shadow name', () => {
    expect(judgeShadowTokens('dark', { 'shadow.small': { $value: [layer(0.9)] } })).toEqual([]);
    for (const name of Object.keys(AGREED_LIGHT_SHADOWS)) expect(name).toContain('shadow');
  });

  test.each([
    [
      'a text token',
      'a { box-shadow: 0 4px 6px color-mix(in oklch, var(--cinder-text-default) 8%, transparent); }',
    ],
    ['an ink token', 'a { box-shadow: 0 0 4px var(--cinder-polarity-ink); }'],
    ['currentColor', 'a { box-shadow: 0 0 8px currentColor; }'],
    ['white', 'a { box-shadow: 0 0 8px white; }'],
    ['#fff', 'a { box-shadow: inset 0 0 8px #FFF; }'],
    ['a shadow custom property', ':root { --panel-shadow: 0 0 8px var(--cinder-text-muted); }'],
    ['a drop-shadow filter', 'a { filter: drop-shadow(0 0 6px var(--cinder-text-default)); }'],
    ['a camelCase style', "const style = { boxShadow: '0 0 8px white' };"],
    [
      'a value over several lines',
      'a {\n  box-shadow:\n    0 1px 2px black,\n    0 4px 8px white;\n}',
    ],
  ])('reports %s', (_name, source) => {
    expect(findBrightShadows(`first line\n${source}`)).toHaveLength(1);
  });

  test.each([
    ['rgba with commas', 'rgba(255, 255, 255, 0.4)'],
    ['rgb with spaces and a leading-dot alpha', 'rgb(255 255 255 / .5)'],
    ['rgb without alpha', 'rgb(255,255,255)'],
    ['rgb percentages', 'rgb(100% 100% 100% / 0.3)'],
    ['8-digit hex', '#ffffff80'],
    ['4-digit hex', '#fff8'],
    ['uppercase 8-digit hex', '#FFFFFFCC'],
    ['hsl white', 'hsl(0 0% 100% / 0.4)'],
    ['hsla white with commas', 'hsla(0, 0%, 100%, 0.4)'],
    ['oklch white', 'oklch(100% 0 0 / 0.4)'],
    ['oklch white as a fraction', 'oklch(1 0 0 / 0.4)'],
  ])('reports white written as %s', (_name, color) => {
    expect(findBrightShadows(`a { box-shadow: 0 0 0 2px ${color}; }`)).toHaveLength(1);
    expect(findBrightShadows(`:root { --thumb-shadow-dark: ${color}; }`)).toHaveLength(1);
  });

  test('accepts black, near-black and mid colours written in the same forms', () => {
    for (const color of [
      'rgba(0, 0, 0, 0.5)',
      'rgb(255 0 0 / .5)',
      'rgb(25 255 255)',
      '#00000080',
      '#fffabc',
      'hsl(0 0% 10% / 0.4)',
      'oklch(10% 0 0 / 0.4)',
      'oklch(0.1 0 0)',
    ]) {
      expect(findBrightShadows(`a { box-shadow: 0 0 0 2px ${color}; }`)).toEqual([]);
    }
  });

  test('accepts black shadows, shadow tokens, ring tokens, comments and unrelated white', () => {
    expect(
      findBrightShadows(
        [
          'a { box-shadow: 0 1px 2px oklch(0% 0 0 / 0.1); }',
          'a { box-shadow: var(--cinder-shadow-md); }',
          'a { box-shadow: 0 0 0 2px var(--cinder-ring-color); }',
          '/* box-shadow: 0 0 8px white; */',
          'a { background: white; color: var(--cinder-text-default); }',
          'a { --_cinder-focus-ring-shadow: 0 0 0 2px var(--cinder-text-default); }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
