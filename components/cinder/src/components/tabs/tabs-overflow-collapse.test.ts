/// <reference lib="dom" />
/**
 * COR-2448 AC2: Tabs collapse into the select only when the bar overflows its container, measured
 * as FilterBar measures its row (the content width the row needs against the width it has), and
 * not because the viewport is narrow. happy-dom lays nothing out, so the geometry is stubbed on the
 * elements the component reads: the tabs root's `clientWidth` (what it has), and the tab list's
 * `scrollWidth` (what the bar needs).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// `rootPadding` is the inline padding of the tabs root: its `clientWidth` includes it, while the bar
// is only as wide as the root's content box.
const geometry = { rootWidth: 375, barNeed: 240, rootPadding: 0 };

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList.contains('cinder-tabs')) return geometry.rootWidth;
    return this.classList.contains('cinder-tab-list')
      ? geometry.rootWidth - 2 * geometry.rootPadding
      : 0;
  },
});
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains('cinder-tab-list')
      ? Math.max(geometry.barNeed, geometry.rootWidth - 2 * geometry.rootPadding)
      : 0;
  },
});

// The width observer the component creates, so a test can say the container changed.
const resizeCallbacks: Array<() => void> = [];
const originalResizeObserver = globalThis.ResizeObserver;
class StubResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

afterAll(() => {
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  }
  if (originalScrollWidth) {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
  }
  globalThis.ResizeObserver = originalResizeObserver;
});

const { cleanup, render } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: Harness } = await import('./tabs-overflow-harness.test.svelte');

function resizeTo(width: number): void {
  geometry.rootWidth = width;
  for (const callback of resizeCallbacks) callback();
  flushSync();
}

afterEach(() => {
  cleanup();
  resizeCallbacks.length = 0;
  geometry.rootWidth = 375;
  geometry.barNeed = 240;
  geometry.rootPadding = 0;
  document.body.replaceChildren();
});

function collapsed(container: HTMLElement): boolean {
  return container.querySelector('.cinder-tabs')?.hasAttribute('data-cinder-collapsed') ?? false;
}

describe('Tabs collapse on overflow (COR-2448 AC2)', () => {
  test('three tabs that fit stay a bar at 375px', () => {
    geometry.rootWidth = 375;
    geometry.barNeed = 240;
    const { container } = render(Harness);
    flushSync();

    expect(collapsed(container)).toBe(false);
    expect(container.querySelector('.cinder-select')).toBeNull();
    expect(container.querySelector('[role="tablist"]')?.hasAttribute('hidden')).toBe(false);
  });

  test('a set that overflows its container collapses into the select', () => {
    geometry.rootWidth = 375;
    geometry.barNeed = 620;
    const { container } = render(Harness, {
      props: { names: ['Overview', 'Workers', 'Settings', 'Access', 'Audit log', 'Storage'] },
    });
    flushSync();

    expect(collapsed(container)).toBe(true);
    expect(container.querySelector('.cinder-select')).not.toBeNull();
    expect(container.querySelector('[role="tablist"]')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(6);
  });

  test('the same set is a bar again once its container is wide enough for it', () => {
    geometry.rootWidth = 375;
    geometry.barNeed = 620;
    const { container } = render(Harness);
    flushSync();
    expect(collapsed(container)).toBe(true);

    resizeTo(500);
    expect(collapsed(container)).toBe(true);

    resizeTo(640);
    expect(collapsed(container)).toBe(false);
    expect(container.querySelector('[role="tablist"]')?.hasAttribute('hidden')).toBe(false);
  });

  test('a container that narrows under a bar that fit collapses it', () => {
    geometry.rootWidth = 800;
    geometry.barNeed = 620;
    const { container } = render(Harness);
    flushSync();
    expect(collapsed(container)).toBe(false);

    resizeTo(375);
    expect(collapsed(container)).toBe(true);
  });

  test('a root with inline padding settles: the bar collapses once and stays, with no update loop', () => {
    // The root measures 400 across, 380 of it the bar's, and the tabs need 390: they overflow the
    // bar's 380, yet 390 is under the root's 400. Judging the room by the root's padding box
    // un-collapsed the bar, the next pass collapsed it again, and the effect never settled
    // (effect_update_depth_exceeded, which the application's boundary caught).
    geometry.rootWidth = 400;
    geometry.rootPadding = 10;
    geometry.barNeed = 390;
    const { container } = render(Harness);
    flushSync();
    expect(collapsed(container)).toBe(true);

    resizeTo(400);
    expect(collapsed(container)).toBe(true);

    resizeTo(420);
    expect(collapsed(container)).toBe(false);
  });

  test('collapseOnOverflow={false} keeps a bar that scrolls sideways', () => {
    geometry.rootWidth = 375;
    geometry.barNeed = 620;
    const { container } = render(Harness, { props: { collapseOnOverflow: false } });
    flushSync();

    expect(collapsed(container)).toBe(false);
    expect(container.querySelector('.cinder-select')).toBeNull();
  });
});
