/// <reference lib="dom" />
/**
 * COR-2012 (B04, rows 04l 10e 10f 10g): the bar picks its layout from the viewport (phone under
 * 640px, tablet under 1024px) and steps down further when its own width cannot hold the wider form.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// A controllable `matchMedia`, installed before the first query is read.
type Listener = (event: Event) => void;
const listeners = new Set<Listener>();
let viewportWidth = 1440;
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => {
    const limit = Number(/width < (\d+)px/.exec(query)?.[1] ?? 0);
    return {
      media: query,
      get matches() {
        return viewportWidth < limit;
      },
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    };
  },
});

afterAll(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

// A ResizeObserver whose reports the test controls, so the bar's own width can be set.
const observers = new Set<(width: number) => void>();
const originalResizeObserver = globalThis.ResizeObserver;
class FakeResizeObserver {
  constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {}
  observe(): void {
    const report = (width: number): void => this.callback([{ contentRect: { width } }], this);
    observers.add(report);
  }
  unobserve(): void {}
  disconnect(): void {
    observers.clear();
  }
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: FakeResizeObserver,
});

afterAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: originalResizeObserver,
  });
});

const { cleanup, render } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: FilterBar } = await import('./filter-bar.svelte');

function setViewport(width: number): void {
  viewportWidth = width;
  for (const listener of listeners) listener(new Event('change'));
  flushSync();
}

function setBarWidth(width: number): void {
  for (const report of observers) report(width);
  flushSync();
}

afterEach(() => {
  cleanup();
  observers.clear();
  setViewport(1440);
});

const SEGMENTS = [
  { value: 'all', label: 'All', count: 19 },
  { value: 'waiting', label: 'Waiting on you', count: 2 },
  { value: 'running', label: 'Running', count: 0 },
  { value: 'done', label: 'Done', count: 15 },
  { value: 'failed', label: 'Failed', count: 1 },
  { value: 'canceled', label: 'Canceled', count: 1 },
];

const FACETS = [
  {
    type: 'choice' as const,
    key: 'startedBy',
    label: 'Started by',
    options: [{ value: 'chats', label: 'Chats' }],
  },
  {
    type: 'choice' as const,
    key: 'agent',
    label: 'Agent',
    multiple: false,
    options: [{ value: 'tool-runner', label: 'Tool runner' }],
  },
];

function layoutOf(container: HTMLElement): string | null {
  return container.querySelector('.cinder-filter-bar')?.getAttribute('data-cinder-layout') ?? null;
}

describe('FilterBar layout by viewport', () => {
  test('a desktop viewport draws the wide form', () => {
    const { container } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    expect(layoutOf(container)).toBe('wide');
    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  test('a tablet viewport draws the medium form', () => {
    setViewport(768);
    const { container } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    expect(layoutOf(container)).toBe('medium');
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container.querySelector('.cinder-select__prefix')?.textContent).toBe('Status:');
  });

  test('a phone viewport draws the narrow form, and crossing 640 switches it live', () => {
    setViewport(700);
    const { container } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    expect(layoutOf(container)).toBe('medium');
    setViewport(375);
    expect(layoutOf(container)).toBe('narrow');
    expect(container.querySelector('.cinder-filter-bar__menu-button')).not.toBeNull();
    expect(container.querySelector('.cinder-filter-bar__chip')).toBeNull();
    setViewport(1280);
    expect(layoutOf(container)).toBe('wide');
  });

  test('a forced layout wins over the viewport', () => {
    setViewport(375);
    const { container } = render(FilterBar, { segments: SEGMENTS, layout: 'wide' });
    expect(layoutOf(container)).toBe('wide');
  });

  test('a bar of selects and search never collapses', () => {
    setViewport(375);
    const { container } = render(FilterBar, {
      facets: [
        { type: 'select', key: 'kind', label: 'Kind', options: [{ value: 'fact', label: 'Fact' }] },
      ],
    });
    expect(layoutOf(container)).toBe('wide');
    expect(container.querySelector('.cinder-filter-bar__menu-button')).toBeNull();
  });
});

describe('FilterBar layout by its own width', () => {
  test('a wide viewport beside a wide sidebar steps down instead of overflowing', () => {
    const { container } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    expect(layoutOf(container)).toBe('wide');
    // 1024px of viewport leaves roughly 780px for the bar behind a 190px sidebar.
    setBarWidth(780);
    expect(layoutOf(container)).toBe('medium');
    setBarWidth(340);
    expect(layoutOf(container)).toBe('narrow');
    setBarWidth(1200);
    expect(layoutOf(container)).toBe('wide');
  });

  test('a bar with few controls stays wide at the width that would fold a full bar', () => {
    const { container } = render(FilterBar, {
      segments: [
        { value: 'all', label: 'All', count: 3 },
        { value: 'paused', label: 'Paused', count: 1 },
        { value: 'problems', label: 'Problems', count: 1 },
      ],
      facets: [
        {
          type: 'choice',
          key: 'starts',
          label: 'Starts',
          options: [{ value: 'schedule', label: 'On a schedule' }],
        },
      ],
    });
    setBarWidth(780);
    expect(layoutOf(container)).toBe('wide');
  });

  test('the viewport still narrows a bar that fits', () => {
    setViewport(375);
    const { container } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    setBarWidth(4000);
    expect(layoutOf(container)).toBe('narrow');
  });
});
