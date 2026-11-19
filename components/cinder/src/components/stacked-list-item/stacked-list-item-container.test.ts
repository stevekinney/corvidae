/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import type { StatusListRow } from '../../test/fixtures/status-list-fixture.svelte';

setupHappyDom();

// The viewport is 1280px wide throughout: `matchMedia` never reports a phone.
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    media: query,
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }),
});

// happy-dom performs no layout, so a `ResizeObserver` stands in for the row's own width.
type Callback = (entries: ResizeObserverEntry[]) => void;
const observers = new Map<Element, Callback>();
const originalResizeObserver = globalThis.ResizeObserver;
class StubResizeObserver {
  #callback: Callback;
  constructor(callback: Callback) {
    this.#callback = callback;
  }
  observe(target: Element) {
    observers.set(target, this.#callback);
  }
  unobserve(target: Element) {
    observers.delete(target);
  }
  disconnect() {
    for (const [target, callback] of observers)
      if (callback === this.#callback) observers.delete(target);
  }
}
globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

const { render, cleanup } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: ExtrasFixture } =
  await import('../../test/fixtures/stacked-list-item-extras-fixture.svelte');
const { default: StatusListFixture } =
  await import('../../test/fixtures/status-list-fixture.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

afterEach(() => {
  cleanup();
  observers.clear();
});

function resizeRow(row: Element, width: number): void {
  const callback = observers.get(row);
  expect(callback).toBeDefined();
  callback?.([{ contentRect: { width } } as unknown as ResizeObserverEntry]);
  flushSync();
}

const rows: StatusListRow[] = [
  {
    id: 'a',
    title: 'Refund order 4471',
    day: 'Today',
    status: 'Waiting on you',
    time: '10:42 AM',
    meta: 'Chat',
  },
];

describe('StackedListItem chooses its layout from its own width (COR-2448)', () => {
  test('a 360px pane in a 1280px viewport takes the phone form: the status moves to line two', () => {
    const { container } = render(StatusListFixture, { props: { rows } });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row).not.toBeNull();
    if (!row) return;
    // Before the row has a width the viewport stands in: 1280px is not a phone.
    expect(row.hasAttribute('data-cinder-phone')).toBe(false);
    resizeRow(row, 360);
    expect(row.hasAttribute('data-cinder-phone')).toBe(true);
    resizeRow(row, 900);
    expect(row.hasAttribute('data-cinder-phone')).toBe(false);
  });

  test('on a phone the status and the metadata draw no comma or dot between them (COR-2449)', () => {
    const { container } = render(StatusListFixture, { props: { rows } });
    const row = container.querySelector('.cinder-stacked-list-item');
    if (!row) throw new Error('no row');
    resizeRow(row, 360);
    const status = row.querySelector('.cinder-stacked-list-item__status')?.textContent ?? '';
    const meta = row.querySelector('.cinder-stacked-list-item__meta')?.textContent ?? '';
    expect(status).toContain('Waiting on you');
    expect(meta).toBe('Chat');
    expect(`${status}${meta}`).not.toMatch(/[,.]/);
    expect(`${status}${meta}`).not.toContain(String.fromCodePoint(0xb7));
  });

  test('the actions collapse into one menu button in a narrow pane and are buttons in a wide one', () => {
    // Two or more collapse; a single action stays its own compact button (never a menu of one).
    const actions = [
      { label: 'Memory', href: '/memory' },
      { label: 'New chat', href: '/chat' },
    ];
    const { container } = render(ExtrasFixture, { props: { mode: 'actions', actions } });
    const row = container.querySelector('.cinder-stacked-list-item');
    if (!row) throw new Error('no row');
    expect(container.querySelector('.cinder-stacked-list-item__actions')).not.toBeNull();
    resizeRow(row, 360);
    expect(container.querySelector('.cinder-stacked-list-item__actions')).toBeNull();
    expect(container.querySelector('.cinder-stacked-list-item__actions-trigger')).not.toBeNull();
  });

  test('an observer callback with no entries leaves the measured width as it was', () => {
    const actions = [
      { label: 'Memory', href: '/memory' },
      { label: 'New chat', href: '/chat' },
    ];
    const { container } = render(ExtrasFixture, { props: { mode: 'actions', actions } });
    const row = container.querySelector('.cinder-stacked-list-item');
    if (!row) throw new Error('no row');
    const callback = observers.get(row);
    expect(callback).toBeDefined();
    // An empty list, and a call that passes none (a test double may do either), both change nothing.
    expect(() => callback?.([])).not.toThrow();
    expect(() => (callback as unknown as () => void)()).not.toThrow();
    flushSync();
    expect(container.querySelector('.cinder-stacked-list-item__actions')).not.toBeNull();
    resizeRow(row, 360);
    expect(() => callback?.([])).not.toThrow();
    flushSync();
    expect(container.querySelector('.cinder-stacked-list-item__actions-trigger')).not.toBeNull();
  });

  test('a single action stays its own compact button in a narrow pane', () => {
    const actions = [{ label: 'Memory', href: '/memory' }];
    const { container } = render(ExtrasFixture, { props: { mode: 'actions', actions } });
    const row = container.querySelector('.cinder-stacked-list-item');
    if (!row) throw new Error('no row');
    resizeRow(row, 360);
    expect(container.querySelector('.cinder-stacked-list-item__actions')).not.toBeNull();
    expect(container.querySelector('.cinder-stacked-list-item__actions-trigger')).toBeNull();
  });

  test('every phone rule is a container query on the row; only the line-two status column reads the viewport', () => {
    // A row that follows the window (`phoneWidth="viewport"`) is the one exception: the container
    // queries pass it by, and its phone rules read the script's phone mark beside its own.
    for (const match of stylesheet.matchAll(/data-cinder-phone\b(?!-)/g)) {
      expect(stylesheet.slice(Math.max(0, match.index - 40), match.index)).toContain(
        "[data-cinder-phone-width='viewport']",
      );
    }
    for (const block of stylesheet
      .split('@container cinder-stacked-list-item (max-width: 639.98px) {')
      .slice(1)) {
      expect(block.slice(0, block.indexOf('\n  }\n'))).toContain(
        "[data-cinder-phone-width='viewport']",
      );
    }
    expect(stylesheet).not.toMatch(/@media[^{]*(?:max-width|min-width|width\s*[<>])/);
    // The one viewport rule: the chat list's line-two status keeps its fixed column in a narrow
    // pane of a wide window (previews line up) and gives it up on a phone (COR-2016), which the
    // row's own width cannot tell apart. Every selector that reads the viewport mark is a
    // line-two one.
    const viewportSelectors = [
      ...stylesheet.matchAll(/\n {2}([^{}\n]*\[data-cinder-viewport-phone\][^{]*)\{/g),
    ].map((match) => match[1] ?? '');
    expect(viewportSelectors).toHaveLength(3);
    for (const selector of viewportSelectors) {
      expect(selector).toContain('--status-line-two');
      expect(selector).not.toContain('--status-leading');
    }
    const phoneRules = stylesheet.split(
      '@container cinder-stacked-list-item (max-width: 639.98px)',
    );
    // The comma, the grid, the detail line and the status rules each have a block of their own.
    expect(phoneRules.length - 1).toBeGreaterThanOrEqual(5);
    expect(phoneRules[2]).toContain('--status-leading');
    expect(stylesheet).toContain('container-type: inline-size');
  });
});
