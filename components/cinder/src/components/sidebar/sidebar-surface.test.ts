/**
 * COR-2315: the sidebar is a tonal surface (`--cinder-surface`) with no rule beside it. The paint cannot be evaluated
 * here, so these pin the declarations.
 */
import { describe, expect, test } from 'bun:test';

import { declarationsFor } from '../../test/css.ts';

const sidebarCss = await Bun.file(new URL('./sidebar.css', import.meta.url)).text();

describe('Sidebar surface', () => {
  test('is a tonal surface that sets the sidebar apart from the page', () => {
    const column = declarationsFor(sidebarCss, '.cinder-sidebar');
    expect(column.get('background')).toBe('var(--cinder-surface)');
  });

  test('keeps the surface COR-2308 tuned so the focus ring reads on it', () => {
    const column = declarationsFor(sidebarCss, '.cinder-sidebar');
    expect(column.get('background')).not.toContain('surface-inset');
  });

  test('a modal drawer shows the selected row as an ink tint, not a raised pill', () => {
    const selected = declarationsFor(
      sidebarCss,
      ".cinder-sidebar--mobile .cinder-navigation-item[data-variant='vertical'][data-active='true']",
    );
    expect(selected.get('background-color')).toBe(
      'color-mix(in oklch, var(--cinder-border-ink), transparent 93%)',
    );
    expect(selected.get('box-shadow')).toBe('none');
  });

  test('draws no inline-end border', () => {
    const column = declarationsFor(sidebarCss, '.cinder-sidebar');
    expect(column.get('border-inline-end')).toBe('none');
    expect(sidebarCss).not.toMatch(/border-inline-end:\s*1px/);
  });

  test('the collapsed rail keeps the primary action as its accent plus alone', () => {
    // `declarationsFor` splits a selector list on commas, which would split `:is(a, button)`.
    expect(sidebarCss).toMatch(
      /\.cinder-sidebar\[data-cinder-collapsed\] \.cinder-side-navigation__primary-action > :is\(a, button\) \{[^}]*justify-content: center;[^}]*font-size: 0;/,
    );
    expect(sidebarCss).toMatch(
      /\.cinder-sidebar\[data-cinder-collapsed\]\s+\.cinder-side-navigation__primary-action\s+> :is\(a, button\)\s+\[data-cinder-shortcut\] \{[^}]*display: none;/,
    );
  });
});
