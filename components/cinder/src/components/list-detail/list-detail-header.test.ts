/// <reference lib="dom" />
/**
 * ListDetail's pane header is the same height with and without actions (COR-2388): every action
 * in it draws at the compact control height, as in PageHeader, SectionHeading and Card, so it never
 * outgrows the title line beside it. happy-dom has no layout engine, so these read the size and
 * compact markers the rendered buttons carry, which Button turns into that height.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { declarationsFor } from '@lostgradient/component-tooling/test/css.ts';
import { setupHappyDom } from '@lostgradient/testing';

const sectionHeadingCss = await Bun.file(
  new URL('../section-heading/section-heading.css', import.meta.url),
).text();

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte/pure');
const { default: Harness } = await import('./list-detail-header-actions.test.svelte');

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ListDetail pane header with actions', () => {
  test('a host action draws at the compact height, so it never grows the header', () => {
    const { getByRole } = render(Harness, { props: { withActions: true } });
    const button = getByRole('button', { name: 'New chat' });
    expect(button.closest('.cinder-list-detail__header')).not.toBeNull();
    expect(button.getAttribute('data-cinder-size')).toBe('xs');
    expect(button.hasAttribute('data-cinder-compact')).toBe(true);
  });

  test('the action is centred on the title line by a margin, so the row stays one line tall', () => {
    const { getByRole } = render(Harness, { props: { withActions: true } });
    const actions = getByRole('button', { name: 'New chat' }).closest(
      '.cinder-section-heading__actions',
    );
    expect(actions).not.toBeNull();
    expect(actions?.closest('.cinder-list-detail__header')).not.toBeNull();
    // The rule that produces the height: the compact action's margin is half of the difference
    // between the title's line and the 24px control, a negative value that cancels the overflow.
    const rule = declarationsFor(sectionHeadingCss, '.cinder-section-heading__actions');
    expect(rule.get('margin-block')?.replaceAll(/\s+/g, '')).toBe(
      'calc((1lh-var(--_cinder-compact-control-height))/2)',
    );
    expect(rule.get('line-height')).toBe('var(--cinder-leading-tight)');
  });

  test('a compact ghost text button keeps the sm side padding, so its content holds its inset', () => {
    const css = Bun.file(new URL('./list-detail.css', import.meta.url));
    return css.text().then((text) => {
      const rule = declarationsFor(
        text,
        ".cinder-list-detail__header .cinder-button[data-cinder-compact][data-cinder-variant='ghost']:not([data-cinder-icon-only])",
      );
      expect(rule.get('padding-inline')).toBe('var(--cinder-button-padding-x-sm)');
    });
  });

  // COR-2438: the header's first row starts on the header's own edge, the search field's, whatever
  // it holds: the list toggle is a handle on the divider, not a slot in the header.
  test('the first row of the header, whatever it is, starts on the header’s own edge', async () => {
    const text = await Bun.file(new URL('./list-detail.css', import.meta.url)).text();
    expect(text).not.toContain('.cinder-list-detail__header > :first-child');
    expect(text).not.toContain('cinder-section-heading__primary');
    expect(text).not.toContain('data-cinder-list-detail-header-start');
  });

  test('the toggle is drawn outside the header while the panes sit side by side and the list can be hidden, with no item open, with its own icon', () => {
    const { container } = render(Harness, { props: { collapsible: true } });
    // Happy-dom measures no width, which ListDetail treats as wide: side by side.
    const toggle = container.querySelector('.cinder-list-detail__toggle button');
    expect(toggle).not.toBeNull();
    expect(toggle?.closest('.cinder-list-detail__header')).toBeNull();
    // Not the application sidebar's panel icon.
    expect(toggle?.querySelector('.lucide-panel-left-close, .lucide-panel-left')).toBeNull();
    expect(toggle?.querySelector('.lucide-chevrons-left')).not.toBeNull();
  });
});
