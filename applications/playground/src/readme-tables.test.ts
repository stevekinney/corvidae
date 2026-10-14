import { describe, expect, test } from 'bun:test';

import { wrapReadmeTables } from './readme-tables.ts';

describe('wrapReadmeTables', () => {
  test('wraps each table in a focusable, labelled scroll region', () => {
    const html =
      '<p>Before</p><table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>';

    expect(wrapReadmeTables(html)).toBe(
      '<p>Before</p>' +
        '<div class="readme-table-scroll" role="region" aria-label="Scrollable table" tabindex="0"><table><tr><td>a</td></tr></table></div>' +
        '<div class="readme-table-scroll" role="region" aria-label="Scrollable table" tabindex="0"><table><tr><td>b</td></tr></table></div>',
    );
  });

  test('leaves HTML without tables unchanged', () => {
    expect(wrapReadmeTables('<p>No tables</p>')).toBe('<p>No tables</p>');
  });
});
