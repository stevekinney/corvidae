import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { initializeHighlighter, renderMarkdown } from '@lostgradient/markdown';

import { CINDER_COMPONENT_SOURCE } from './component-sources.ts';
import { readmeTableNames, wrapReadmeTables } from './readme-tables.ts';

describe('wrapReadmeTables', () => {
  test('wraps each table in a focusable region named for its nearest heading', () => {
    const html =
      '<h2>Keyboard</h2><table><tr><td>a</td></tr></table>' +
      '<h2>Props</h2><p>Every prop.</p><table><tr><td>b</td></tr></table>';

    expect(wrapReadmeTables(html)).toBe(
      '<h2>Keyboard</h2>' +
        '<div class="readme-table-scroll" role="region" aria-label="Keyboard table" tabindex="0"><table><tr><td>a</td></tr></table></div>' +
        '<h2>Props</h2><p>Every prop.</p>' +
        '<div class="readme-table-scroll" role="region" aria-label="Props table" tabindex="0"><table><tr><td>b</td></tr></table></div>',
    );
  });

  test('prefers a caption, falls back to position, and numbers repeated names', () => {
    const html =
      '<table><tr><td>first</td></tr></table>' +
      '<h3>Options &amp; &quot;flags&quot;</h3>' +
      '<table><caption>Supported keys</caption><tr><td>k</td></tr></table>' +
      '<table><tr><td>x</td></tr></table>' +
      '<table><tr><td>y</td></tr></table>';

    expect(readmeTableNames(html)).toEqual([
      'Table 1',
      'Supported keys',
      'Options & "flags" table',
      'Options & "flags" table (2)',
    ]);
    expect(wrapReadmeTables(html)).toContain('aria-label="Options &amp; &quot;flags&quot; table"');
  });

  test('leaves HTML without tables unchanged', () => {
    expect(wrapReadmeTables('<p>No tables</p>')).toBe('<p>No tables</p>');
  });

  test.each(['data-grid', 'popover'])(
    'names every table in the %s README distinctly',
    async (name) => {
      await initializeHighlighter();
      const markdown = await Bun.file(
        join(CINDER_COMPONENT_SOURCE.componentsRoot, name, 'README.md'),
      ).text();
      const names = readmeTableNames(renderMarkdown(markdown).html);

      expect(names.length).toBeGreaterThan(1);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('Props table');
    },
  );
});
