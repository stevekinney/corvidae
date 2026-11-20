/// <reference lib="dom" />
/**
 * `metaCompact`: on a phone line two is the compact text in place of `meta`, and only one of the
 * two is ever drawn, so line two is read once; with `wrapMeta` the status leads it, once, and the
 * time and a group row's disclosure stay on line one (row 05w). `phoneWidth="viewport"` takes the
 * phone form from the window and not the row, so a row narrower than 640px on a tablet keeps its
 * status column and its whole line two (row 05x). The layout is measured in a browser
 * (`stacked-list-item-meta-compact.playwright.ts`).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// Whether the window is a phone, which `phoneWidth="viewport"` reads; the rows' own widths come
// from the stubbed `ResizeObserver` below, as happy-dom performs no layout. Cinder reads the phone
// query once for each `matchMedia` in use, so each window installs a new one.
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
function installWindow(phone: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      media: query,
      matches: phone && query.includes('640px'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
}
installWindow(false);

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

const { render, cleanup, within } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: Fixture } = await import('./stacked-list-item-meta-compact.fixture.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

afterEach(() => {
  cleanup();
  observers.clear();
  installWindow(false);
});

/** The fixture's row under `testId`, after its observer reports `width`. */
function rowAt(container: Element, testId: string, width: number): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"] .cinder-stacked-list-item`,
  );
  if (row === null) throw new Error(`No row under ${testId}.`);
  observers.get(row)?.([{ contentRect: { width } } as unknown as ResizeObserverEntry]);
  flushSync();
  return row;
}

const lineTwo = (row: Element) => row.querySelector('.cinder-stacked-list-item__line-two');

describe('metaCompact', () => {
  test('on a phone line two is the compact text, led once by the status, and the wide text is not drawn', () => {
    const { container } = render(Fixture);
    const row = rowAt(container, 'meta-compact', 320);

    expect(lineTwo(row)?.textContent?.replaceAll(/\s+/g, ' ').trim()).toMatch(
      /^Missed runs,? 4 Schedule since Oct 30$/,
    );
    expect(row.querySelector('[data-cinder-meta-compact]')?.textContent?.trim()).toBe(
      'Schedule since Oct 30',
    );
    expect(row.textContent).not.toContain('every day at 3:00 AM');
    // One status: on line two, never in the column as well.
    expect(row.querySelector('.cinder-stacked-list-item__status')).toBeNull();
    expect(within(row).queryAllByText(/Missed runs/)).toHaveLength(1);
    // The time and the disclosure stay on line one.
    const time = row.querySelector('.cinder-stacked-list-item__time');
    expect(time?.textContent).toContain('Oct 30');
    expect(time?.querySelector('button')?.textContent).toContain('Show');
    // The whole line is still the row's tooltip.
    expect(row.querySelector('[title*="every day at 3:00 AM"]')).not.toBeNull();
  });

  test('wider, line two is `meta` and the status leads in its column', () => {
    const { container } = render(Fixture);
    const row = rowAt(container, 'meta-compact', 1024);

    expect(lineTwo(row)?.textContent).toContain(
      'Schedule, Assistant, every day at 3:00 AM (9:00 AM UTC), missed 4 times since Oct 30',
    );
    expect(row.querySelector('[data-cinder-meta-compact]')).toBeNull();
    expect(row.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
      'Missed runs',
    );
  });
});

describe('phoneWidth="viewport"', () => {
  test('a row narrower than 640px in a wide window keeps its status column and its whole line two', () => {
    const { container } = render(Fixture);
    const row = rowAt(container, 'meta-compact-viewport', 600);

    expect(row.getAttribute('data-cinder-phone-width')).toBe('viewport');
    expect(row.hasAttribute('data-cinder-phone')).toBe(false);
    expect(row.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
      'Missed runs',
    );
    expect(lineTwo(row)?.textContent).toContain('Schedule, Assistant, missed 4 times since Oct 30');
  });

  test('in a phone window the row takes the phone form, whatever its own width says', () => {
    installWindow(true);
    const { container } = render(Fixture);
    const row = rowAt(container, 'meta-compact-viewport', 700);

    expect(row.hasAttribute('data-cinder-phone')).toBe(true);
    expect(row.querySelector('[data-cinder-meta-compact]')?.textContent?.trim()).toBe(
      'Schedule since Oct 30',
    );
    expect(row.querySelector('.cinder-stacked-list-item__status-inline')).not.toBeNull();
  });

  test('the row-width queries pass it by, and the window rules carry the phone arrangement', () => {
    const containerBlocks = stylesheet
      .split('@container cinder-stacked-list-item (max-width: 639.98px) {')
      .slice(1);
    expect(containerBlocks.length).toBeGreaterThan(0);
    for (const block of containerBlocks) {
      const body = block.slice(0, block.indexOf('\n  }\n'));
      expect(body).toContain("[data-cinder-phone-width='viewport']");
    }
    expect(stylesheet).toMatch(
      /\[data-cinder-phone-width='viewport'\]\[data-cinder-phone\]\.cinder-stacked-list-item--status-leading\s*> \.cinder-stacked-list-item__layout \{[^}]*'leading status line line trailing'/,
    );
  });
});
