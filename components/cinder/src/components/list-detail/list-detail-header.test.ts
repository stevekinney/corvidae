/// <reference lib="dom" />
/**
 * ListDetail's pane header is the same height with and without actions (COR-2388): every action
 * in it draws at the compact control height, as in PageHeader, SectionHeading and Card, so it never
 * outgrows the title line beside it. happy-dom has no layout engine, so these read the size and
 * compact markers the rendered buttons carry, which Button turns into that height.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { declarationsFor } from '../../test/css.ts';

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
});
