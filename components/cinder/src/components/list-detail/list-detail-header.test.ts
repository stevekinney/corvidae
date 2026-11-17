/// <reference lib="dom" />
/**
 * ListDetail's pane header is the same height with and without actions (COR-2388): every action
 * in it draws at the compact control height, as in PageHeader, SectionHeading and Card, so it never
 * outgrows the title line beside it. happy-dom has no layout engine, so these read the size and
 * compact markers the rendered buttons carry, which Button turns into that height.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

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
});
