/**
 * COR-2315: the sidebar is a tonal surface (`--cinder-surface`) with no rule beside it. The paint cannot be evaluated
 * here, so these pin the declarations.
 */
import { describe, expect, test } from 'bun:test';

import { declarationsFor } from '@lostgradient/component-tooling/test/css.ts';

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
  });

  test('a selected row keeps the focus ring, in the drawer and in the column', async () => {
    // A vertical row draws its ring with `box-shadow`, so neither the drawer nor the selected row
    // sets `box-shadow`: the vertical row's inset ring is the only one.
    const drawerSelected = declarationsFor(
      sidebarCss,
      ".cinder-sidebar--mobile .cinder-navigation-item[data-variant='vertical'][data-active='true']",
    );
    expect(drawerSelected.has('box-shadow')).toBe(false);

    const navigationItemCss = await Bun.file(
      new URL(
        '../../../../navigation-item/src/components/navigation-item/navigation-item.css',
        import.meta.url,
      ),
    ).text();
    const selected = declarationsFor(
      navigationItemCss,
      ".cinder-navigation-item[data-variant='vertical'][data-active='true']",
    );
    expect(selected.has('box-shadow')).toBe(false);
    const focused = declarationsFor(
      navigationItemCss,
      ".cinder-navigation-item[data-variant='vertical']:focus-visible",
    );
    expect(focused.get('box-shadow')).toContain('inset 0 0 0 var(--cinder-ring-width)');
  });

  test('the selected row and the New chat button differ in background and edge (COR-2450 AC4)', async () => {
    // In light the raised surface and the sidebar surface are both white, so the selected row
    // and the primary action ("New chat", a raised button) read as one shape unless their tokens
    // differ. The selected row is a flat tinted fill with no shadow and no border; the button is
    // the white raised surface with a border and no shadow. `declarationsFor` splits
    // `:is(a, button)` on its comma, so the button rule is read with a pattern.
    const navigationItemCss = await Bun.file(
      new URL(
        '../../../../navigation-item/src/components/navigation-item/navigation-item.css',
        import.meta.url,
      ),
    ).text();
    const sideNavigationCss = await Bun.file(
      new URL('../side-navigation/side-navigation.css', import.meta.url),
    ).text();
    const selected = declarationsFor(
      navigationItemCss,
      ".cinder-navigation-item[data-variant='vertical'][data-active='true']",
    );
    const button = sideNavigationCss.match(
      /\.cinder-side-navigation__primary-action > :is\(a, button\) \{([^}]*)\}/,
    )?.[1];
    if (button === undefined) throw new Error('No primary action rule in side-navigation.css');
    const buttonBackground = button.match(/\bbackground:\s*([^;]+);/)?.[1];
    const buttonShadow = button.match(/\bbox-shadow:\s*([^;]+);/)?.[1];

    expect(selected.get('background-color')).toBe('var(--cinder-selected-background)');
    expect(buttonBackground).toBe('var(--cinder-surface-raised)');
    expect(selected.get('background-color')).not.toBe(buttonBackground);

    // Neither carries a shadow; the button's edge is a border token and the selected row has
    // none, so the two never share an edge.
    expect(selected.has('box-shadow')).toBe(false);
    expect(buttonShadow).toBeUndefined();
    expect(button).toContain('border: 1px solid var(--cinder-border);');
    expect(selected.get('border')).toBeUndefined();
    expect(selected.get('border-bottom-color')).toBe('transparent');
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
