/// <reference lib="dom" />
/**
 * `wrapMeta` on a phone: line two is one run of text, the dot, the word and the meta, so a wrapped
 * line returns to the row's text edge. The row draws its status once: at the start of line two in
 * the phone form, in its column otherwise, never both, so a screen reader hears it once and a text
 * query finds it once. A row without `wrapMeta` keeps it in the column. The layout is measured in
 * a browser (`stacked-list-item-wrap-meta.playwright.ts`).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// The viewport is 1280px wide throughout: `matchMedia` never reports a phone, so the row's own
// width (a `ResizeObserver`, as happy-dom performs no layout) decides the form.
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
const { default: Fixture } = await import('./stacked-list-item-wrap-meta.fixture.svelte');
const { default: StatusListFixture } =
  await import('../../test/fixtures/status-list-fixture.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

afterEach(() => {
  cleanup();
  observers.clear();
});

function resizeRows(container: Element, width: number): Element[] {
  const rows = [...container.querySelectorAll('.cinder-stacked-list-item')];
  for (const row of rows) {
    const callback = observers.get(row);
    expect(callback).toBeDefined();
    callback?.([{ contentRect: { width } } as unknown as ResizeObserverEntry]);
  }
  flushSync();
  return rows;
}

/** The row's status images: the dot with the word as its name. */
function statusImages(row: Element): HTMLElement[] {
  return within(row as HTMLElement).queryAllByRole('img', { name: 'Check not met' });
}

describe('wrapMeta on a phone', () => {
  test('leading-always uses the selected phone width for the same first-line layout', () => {
    const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');
    const containerRule =
      /@container cinder-stacked-list-item \(max-width: 639\.98px\)\s*\{\s*\.cinder-stacked-list-item--lines\.cinder-stacked-list-item--status-leading-always:not\(\s*\[data-cinder-phone-width='viewport'\]\s*\)\s*>\s*\.cinder-stacked-list-item__layout\s*\{([^}]+)\}/u.exec(
        stylesheet,
      );
    const viewportRule =
      /\.cinder-stacked-list-item--lines\[data-cinder-phone-width='viewport'\]\[data-cinder-phone\]\.cinder-stacked-list-item--status-leading-always\s*>\s*\.cinder-stacked-list-item__layout\s*\{([^}]+)\}/u.exec(
        stylesheet,
      );
    expect(containerRule?.[1]?.replace(/\s+/gu, ' ').trim()).toBe(
      viewportRule?.[1]?.replace(/\s+/gu, ' ').trim(),
    );
    expect(containerRule?.[1]).toContain("'status leading title time trailing'");
    expect(containerRule?.[1]).toContain("'line line line line trailing'");
    expect(containerRule?.[1]).toContain('--_cinder-status-track: max-content');
  });
  test('leading-always retains one status in its leading column on phones and wide rows', () => {
    const { container } = render(Fixture, { props: { leadingAlways: true } });
    for (const width of [320, 375, 1024]) {
      for (const row of resizeRows(container, width)) {
        expect(statusImages(row)).toHaveLength(1);
        expect(row.querySelector('.cinder-stacked-list-item__status-inline')).toBeNull();
        expect(row.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
          'Check not met',
        );
        expect(row.classList.contains('cinder-stacked-list-item--status-leading-always')).toBe(
          true,
        );
      }
    }
  });
  test('draws the status at the start of line two, before the meta, and not in the column', () => {
    const { container } = render(Fixture);
    for (const row of resizeRows(container, 320)) {
      const lineTwo = row.querySelector('.cinder-stacked-list-item__line-two');
      const inline = lineTwo?.querySelector('.cinder-stacked-list-item__status-inline');
      expect(inline?.textContent).toContain('Check not met');
      expect(lineTwo?.firstElementChild).toBe(inline ?? null);
      expect(inline?.nextElementSibling?.classList.contains('cinder-stacked-list-item__meta')).toBe(
        true,
      );
      expect(row.querySelector('.cinder-stacked-list-item__status')).toBeNull();
      expect(row.classList.contains('cinder-stacked-list-item--status-inline')).toBe(true);
    }
  });

  test('each row has one status image and one status word, in the phone form and the wide one', () => {
    const { container } = render(Fixture);
    for (const width of [320, 1024]) {
      const rows = resizeRows(container, width);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(statusImages(row)).toHaveLength(1);
        expect(within(row as HTMLElement).queryAllByText('Check not met')).toHaveLength(1);
      }
    }
  });

  test('a wide row keeps its status in the column and draws none in line two', () => {
    const { container } = render(Fixture);
    for (const row of resizeRows(container, 1024)) {
      expect(row.querySelector('.cinder-stacked-list-item__status-inline')).toBeNull();
      expect(row.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
        'Check not met',
      );
      expect(row.classList.contains('cinder-stacked-list-item--status-inline')).toBe(false);
    }
  });

  test('line two spans the status column only in the inline form, and ends before the actions', () => {
    const inlineRules = stylesheet.slice(
      stylesheet.indexOf("a `wrapMeta` row's line two is one run"),
    );
    // Ends at the line before the actions' column, never under the actions (`trailing-start`).
    expect(inlineRules).toMatch(
      /--status-inline \.cinder-stacked-list-item__line-two \{[^}]*grid-column: status \/ trailing-start;/,
    );
    expect(inlineRules).not.toMatch(/grid-column: status \/ trailing;/);
    expect(inlineRules).toMatch(/__status-inline \{[^}]*display: inline-flex;/);
    expect(inlineRules).toMatch(/__description\) \{\s*display: inline;/);
  });

  test('a single action in its own narrow row lets inline status and meta span the real tracks', () => {
    const singleActionRules = stylesheet.slice(
      stylesheet.indexOf('The ordinary inline-status form stops before a trailing column'),
    );
    expect(singleActionRules).toMatch(
      /--single-action:not\([\s\S]*?\)\.cinder-stacked-list-item--status-inline\s+\.cinder-stacked-list-item__line-two\s*\{[^}]*grid-column:\s*status \/ -1;/,
    );
    expect(singleActionRules).not.toContain('trailing-start');
  });

  test('a row without wrapMeta draws no inline status, even on a phone', () => {
    const { container } = render(StatusListFixture, {
      props: {
        rows: [{ id: 'one', title: 'Daily summary', day: 'Today', status: 'Done', meta: 'Chat' }],
      },
    });
    for (const row of resizeRows(container, 320)) {
      expect(row.querySelector('.cinder-stacked-list-item__status-inline')).toBeNull();
      expect(row.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain('Done');
    }
  });
});
