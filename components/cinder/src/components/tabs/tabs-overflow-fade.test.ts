/// <reference lib="dom" />
/**
 * COR-2012 (B04, row 04l): from 640px a tab bar that overflows gets a fade at its inline end, and
 * keyboard focus never lands under it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: TabsHarness } = await import('./tabs-collapse-harness.test.svelte');

const tabsCss = readFileSync(new URL('./tabs.css', import.meta.url), 'utf8');

afterEach(() => cleanup());

describe('Tabs overflow fade', () => {
  test('a horizontal tab list takes the shared inline-end fade', () => {
    const { container } = render(TabsHarness);
    const list = container.querySelector('[role="tablist"]')!;
    expect(list.classList.contains('cinder-_scroll-fade-inline-end')).toBe(true);
  });

  test('a vertical tab list takes none, because it never scrolls sideways', () => {
    const { container } = render(TabsHarness, { props: { orientation: 'vertical' } });
    const list = container.querySelector('[role="tablist"]')!;
    expect(list.classList.contains('cinder-_scroll-fade-inline-end')).toBe(false);
  });

  test('the overflow driver marks a list whose tabs run past its end', async () => {
    const { container } = render(TabsHarness);
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
    // happy-dom lays nothing out, so the measurements are set by hand.
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 900 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 300 });
    list.dispatchEvent(new Event('scroll'));
    await waitUntil(() => list.hasAttribute('data-cinder-overflows-inline-end'));
    expect(list.hasAttribute('data-cinder-overflows-inline-end')).toBe(true);
  });

  test('the fade is in the page surface and the scrollport keeps its width clear of focus', () => {
    const rule = tabsCss.match(/\.cinder-tab-list \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('--_cinder-scroll-fade-color: var(--cinder-surface)');
    expect(rule).toContain('scroll-padding-inline-end: var(--cinder-scroll-fade-size)');
  });
});
