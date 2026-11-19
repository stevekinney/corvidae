import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { collectScannedFiles, findLightShadows, lightReason } from './check-light-shadows';

describe('light shadows', () => {
  test.each([
    [
      'a text token in box-shadow',
      'a { box-shadow: 0 4px 6px color-mix(in oklch, var(--cinder-text-default) 8%, transparent); }',
    ],
    ['an ink token', 'a { box-shadow: 0 0 4px var(--cinder-ink); }'],
    ['the polarity ink token', 'a { box-shadow: 0 0 4px var(--cinder-polarity-ink); }'],
    ['currentColor', 'a { box-shadow: 0 0 8px currentColor; }'],
    ['white', 'a { box-shadow: 0 0 8px white; }'],
    ['#fff', 'a { box-shadow: 0 0 8px #fff; }'],
    ['#ffffff', 'a { box-shadow: 0 0 8px #FFFFFF; }'],
    ['a light oklch percentage', 'a { box-shadow: 0 0 8px oklch(95% 0 0 / 0.4); }'],
    ['a light oklch fraction', 'a { box-shadow: 0 0 8px oklch(0.92 0 0); }'],
    ['a shadow custom property', ':root { --panel-shadow: 0 0 8px var(--cinder-text-muted); }'],
    ['a drop-shadow filter', 'a { filter: drop-shadow(0 0 6px var(--cinder-text-default)); }'],
    ['a camelCase style property', "const style = { boxShadow: '0 0 8px white' };"],
    [
      'an inline style string',
      '<div style="box-shadow: 0 0 8px var(--cinder-text-default)"></div>',
    ],
    [
      'the kanban scroll-edge token',
      ':root { --cinder-kanban-board-scroll-edge: color-mix(in oklch, var(--cinder-text-default), transparent 88%); }',
    ],
    ['an edge custom property', ':root { --panel-edge: var(--cinder-text-default); }'],
    ['a glow custom property', ':root { --panel-glow: white; }'],
    ['a fade custom property', ':root { --panel-fade: oklch(95% 0 0 / 0.3); }'],
    ['a scrim custom property', ':root { --panel-scrim: #fff; }'],
    ['a shade custom property', ':root { --panel-shade: currentColor; }'],
    [
      'a linear-gradient scroll edge',
      '.board-edge::before { background: linear-gradient(90deg, var(--cinder-text-default), transparent); }',
    ],
    [
      'a radial-gradient glow',
      '.glow { background: radial-gradient(circle, white, transparent); }',
    ],
    [
      'a conic-gradient shade',
      '.shade { background: conic-gradient(from 0deg, var(--cinder-ink), transparent); }',
    ],
  ])('reports %s', (_name, source) => {
    expect(findLightShadows(`first line\n${source}`).map((violation) => violation.line)).toEqual([
      2,
    ]);
  });

  test('reads a value that spans lines and reports its first line', () => {
    const source =
      'a {\n  box-shadow:\n    0 1px 2px oklch(0% 0 0 / 0.1),\n    0 4px 8px var(--cinder-text-default);\n}';
    expect(findLightShadows(source).map((violation) => violation.line)).toEqual([2]);
  });

  test.each([
    ['a black elevation token', 'a { box-shadow: var(--cinder-shadow-overlay); }'],
    ['a black oklch', 'a { box-shadow: 0 4px 8px oklch(0% 0 0 / 0.5); }'],
    ['a dark oklch fraction', 'a { box-shadow: 0 4px 8px oklch(0.2 0 0); }'],
    [
      'the scroll shadow token',
      'a { box-shadow: inset 1rem 0 1rem -1rem var(--cinder-scroll-shadow-color); }',
    ],
    ['a ring token', 'a { box-shadow: 0 0 0 2px var(--cinder-ring-color); }'],
    [
      'a ring token beside a black shadow',
      'a { box-shadow: 0 0 0 var(--cinder-ring-width) var(--cinder-ring-color), 0 2px 4px oklch(0% 0 0 / 0.2); }',
    ],
    ['the focus ring shadow reference', 'a { box-shadow: var(--_cinder-focus-ring-shadow); }'],
    [
      'the focus ring shadow declaration',
      ':root { --_cinder-focus-ring-shadow: 0 0 0 2px var(--cinder-text-default); }',
    ],
    [
      'a text color beside the shadow',
      'a { color: var(--cinder-text-default); box-shadow: none; }',
    ],
    ['a block comment', 'a { /* box-shadow: 0 0 4px white; */ box-shadow: none; }'],
    [
      'the kanban scroll-edge token as the scroll shadow color',
      ':root { --cinder-kanban-board-scroll-edge: var(--cinder-scroll-shadow-color); }',
    ],
    [
      'a gradient scroll edge from a black shadow token',
      '.board { background: linear-gradient(90deg, var(--cinder-scroll-shadow-color), transparent); }',
    ],
    [
      'a white gradient that is not an edge',
      '.swatch { background: linear-gradient(90deg, white, black); }',
    ],
    ['a longer property name','a { text-box-shadow-like: white; }'],
  ])('accepts %s', (_name, source) => {
    expect(findLightShadows(source)).toEqual([]);
  });

  test('names the reason', () => {
    expect(lightReason('0 0 4px var(--cinder-text-default)')).toContain('--cinder-text-');
    expect(lightReason('0 0 4px oklch(90% 0 0)')).toContain('90%');
    expect(lightReason('0 0 4px oklch(89% 0 0)')).toBeUndefined();
  });

  test('scans css, svelte and ts sources, and skips tests and dependencies', () => {
    const directory = mkdtempSync(join(tmpdir(), 'check-light-shadows-'));
    try {
      for (const file of [
        'a.css',
        'nested/b.svelte',
        'c.ts',
        'c.test.ts',
        'node_modules/d.css',
        '.hidden/e.css',
        'readme.md',
      ]) {
        mkdirSync(join(directory, file, '..'), { recursive: true });
        writeFileSync(join(directory, file), '');
      }
      const paths: string[] = [];
      collectScannedFiles(directory, paths);
      expect(paths.map((path) => relative(directory, path)).toSorted()).toEqual([
        'a.css',
        'c.ts',
        'nested/b.svelte',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
