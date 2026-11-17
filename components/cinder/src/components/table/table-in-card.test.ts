/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('./table-in-card.fixture.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('Table inside a Card', () => {
  test('is frameless by default, so the card is the only frame', () => {
    const { container } = render(Fixture, {});

    expect(container.querySelectorAll('[data-cinder-frameless]').length).toBe(2);
  });

  test('framed keeps the table frame inside the card', () => {
    const { container } = render(Fixture, { framed: true });

    expect(container.querySelector('[data-cinder-frameless]')).toBeNull();
  });

  test('a table outside a card keeps its frame, and framed changes nothing there', () => {
    const { container } = render(Fixture, { inCard: false });

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('[data-cinder-frameless]')).toBeNull();
  });

  test('a plain card has no frame to share, so its table keeps its own', () => {
    const { container } = render(Fixture, { cardVariant: 'plain' });

    expect(container.querySelector('[data-cinder-frameless]')).toBeNull();
  });

  test('a pinned header and the scroll fade take the card fill, not the page canvas', async () => {
    const css = await Bun.file(new URL('./table.css', import.meta.url)).text();

    expect(css).toMatch(
      /\.cinder-card\[data-cinder-variant='card'\]\s+\.cinder-table-scroll\[data-cinder-frameless\]\s*\{[^}]*--_cinder-scroll-fade-color:\s*var\(--cinder-surface-raised\)/,
    );
    expect(css).toMatch(
      /\.cinder-card\[data-cinder-variant='card'\]\s+\.cinder-table\[data-cinder-frameless\]\[data-cinder-sticky-header\]\s*>\s*\.cinder-table__header\s*\{[^}]*background:\s*var\(--cinder-surface-raised\)/,
    );
  });

  test('frameless still wins when framed is also set', () => {
    const { container } = render(Fixture, { frameless: true, framed: true });

    expect(container.querySelectorAll('[data-cinder-frameless]').length).toBe(2);
  });
});
