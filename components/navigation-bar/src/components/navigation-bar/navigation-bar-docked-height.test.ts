/// <reference lib="dom" />
/**
 * A bottom NavigationBar (a phone's tab bar) publishes its height as a docked action bar does, so
 * the toast region sits above it rather than over its tabs (COR-2327). A top bar publishes nothing,
 * and a bar that unmounts or moves to the top takes its height back.
 */
import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { textSnippet } from './navigation-bar-snippet-helpers.ts';

setupHappyDom();
const { render, cleanup } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: NavigationBar } = await import('./navigation-bar.svelte');
const { DOCKED_BAR_HEIGHT_PROPERTY } =
  await import('@lostgradient/foundation/_internal/docked-bar-height.ts');

const originalRect = HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  document.documentElement.style.removeProperty(DOCKED_BAR_HEIGHT_PROPERTY);
});

function published(): string {
  return document.documentElement.style.getPropertyValue(DOCKED_BAR_HEIGHT_PROPERTY);
}

/** The box of a bar `height` tall whose bottom edge is the bottom of the viewport. */
function dockedBox(height: number): DOMRect {
  return { height, top: window.innerHeight - height, bottom: window.innerHeight } as DOMRect;
}

describe('NavigationBar and the toast region', () => {
  test('a bottom bar publishes its height while mounted and takes it back on unmount', async () => {
    HTMLElement.prototype.getBoundingClientRect = () => dockedBox(64.4);
    const { unmount } = render(NavigationBar, {
      placement: 'bottom',
      items: textSnippet('tabs'),
    });

    await waitUntil(() => published() !== '');
    expect(published()).toBe('65px');
    unmount();
    expect(published()).toBe('');
  });

  test('a top bar publishes nothing', () => {
    HTMLElement.prototype.getBoundingClientRect = () => dockedBox(56);
    render(NavigationBar, { items: textSnippet('links') });
    flushSync();

    expect(published()).toBe('');
  });

  test('a bar that moves from the bottom to the top takes its height back', async () => {
    HTMLElement.prototype.getBoundingClientRect = () => dockedBox(64);
    const { rerender } = render(NavigationBar, {
      placement: 'bottom',
      items: textSnippet('tabs'),
    });
    await waitUntil(() => published() !== '');

    await rerender({ placement: 'top', items: textSnippet('tabs') });
    flushSync();

    expect(published()).toBe('');
  });
});
