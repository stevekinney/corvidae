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

// happy-dom lays nothing out, so the row reports what a browser would: its own width, and a
// `scrollWidth` of the larger of that and what the drawn form's controls need.
let barWidth = 0;
let needs: Record<string, number> = { wide: 0, medium: 0, narrow: 0 };
const ownClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const ownScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
function isRow(element: HTMLElement): boolean {
  return element.classList.contains('cinder-filter-bar__row');
}
function drawnForm(element: HTMLElement): string {
  return element.closest('.cinder-filter-bar')?.getAttribute('data-cinder-layout') ?? 'wide';
}
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return isRow(this) ? barWidth : 0;
  },
});
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return isRow(this) ? Math.max(barWidth, needs[drawnForm(this)] ?? 0) : 0;
  },
});

afterAll(() => {
  if (ownClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', ownClientWidth);
  else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  if (ownScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', ownScrollWidth);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
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
  barWidth = width;
  for (const report of observers) report(width);
  flushSync();
}

afterEach(() => {
  cleanup();
  observers.clear();
  barWidth = 0;
  needs = { wide: 0, medium: 0, narrow: 0 };
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

const AGENT_APPLIED = [{ key: 'agent', value: 'tool-runner', label: 'Agent' }];

describe('FilterBar layout by its measured width', () => {
  test('a row that fits stays wide, however long its labels read', () => {
    // The Runs page at 1280 pixels: a 1042px bar whose controls, with an agent chip applied, need
    // 1021px. A text-length estimate put them at 1119px and folded the segments.
    needs = { wide: 1021, medium: 760, narrow: 300 };
    const { container } = render(FilterBar, {
      segments: SEGMENTS,
      facets: FACETS,
      appliedFilters: AGENT_APPLIED,
    });
    setBarWidth(1042);
    expect(layoutOf(container)).toBe('wide');
    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  test('a row that overflows steps down, and steps back up once the wider form fits', () => {
    needs = { wide: 1100, medium: 700, narrow: 300 };
    const { container } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    expect(layoutOf(container)).toBe('wide');
    setBarWidth(1042);
    expect(layoutOf(container)).toBe('medium');
    setBarWidth(600);
    expect(layoutOf(container)).toBe('narrow');
    setBarWidth(800);
    expect(layoutOf(container)).toBe('medium');
    setBarWidth(1099);
    expect(layoutOf(container)).toBe('medium');
    setBarWidth(1100);
    expect(layoutOf(container)).toBe('wide');
  });

  test('a chip removed from a folded bar draws the wide form again when it now fits', async () => {
    needs = { wide: 1100, medium: 700, narrow: 300 };
    const { container, rerender } = render(FilterBar, {
      segments: SEGMENTS,
      facets: FACETS,
      appliedFilters: AGENT_APPLIED,
    });
    setBarWidth(1042);
    expect(layoutOf(container)).toBe('medium');
    needs = { wide: 980, medium: 600, narrow: 300 };
    await rerender({ appliedFilters: [] } as never);
    flushSync();
    expect(layoutOf(container)).toBe('wide');
  });

  test('a folded bar waits for focus to leave before it draws a wider form, so a new count does not remount the control in use', async () => {
    needs = { wide: 1100, medium: 700, narrow: 300 };
    const { container, rerender } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    setBarWidth(1042);
    expect(layoutOf(container)).toBe('medium');
    const select = container.querySelector<HTMLElement>(
      '.cinder-filter-bar__segments-select button',
    );
    if (select === null) throw new Error('The folded segments drew no select');
    select.focus();
    expect(document.activeElement).toBe(select);

    needs = { wide: 1000, medium: 700, narrow: 300 };
    await rerender({ segments: SEGMENTS.map((segment) => ({ ...segment, count: 0 })) } as never);
    flushSync();
    expect(layoutOf(container)).toBe('medium');
    expect(document.activeElement).toBe(select);

    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    flushSync();
    expect(layoutOf(container)).toBe('wide');
    outside.remove();
  });

  test('a bar with no layout to measure keeps the viewport’s form', () => {
    needs = { wide: 5000, medium: 5000, narrow: 5000 };
    const { container } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    setBarWidth(0);
    expect(layoutOf(container)).toBe('wide');
  });

  test('the viewport still narrows a bar that fits', () => {
    setViewport(375);
    const { container } = render(FilterBar, { segments: SEGMENTS, facets: FACETS });
    setBarWidth(4000);
    expect(layoutOf(container)).toBe('narrow');
  });
});
