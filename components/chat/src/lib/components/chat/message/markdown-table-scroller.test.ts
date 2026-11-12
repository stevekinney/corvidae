/**
 * COR-2261: a wide Markdown table scrolls inside a hairline frame whose scroller becomes a named,
 * focusable region with a column cue only while the table overflows. Layout is stubbed here (the
 * DOM has none); the browser harness checks real widths and the arrow keys.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = TestResizeObserver;

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
});

const { render, cleanup, fireEvent, waitFor } = await import('@testing-library/svelte');
const { default: MarkdownTableScroller, countHiddenColumns } =
  await import('./markdown-table-scroller.svelte');

afterEach(() => cleanup());

const tableHtml =
  '<table><thead><tr><th>Name</th><th>Owner</th><th>Status</th><th>Reference</th></tr></thead><tbody><tr><td>Alpha</td><td>Avery</td><td>Ready</td><td>REF-1</td></tr></tbody></table>';

function setLayout(element: Element, box: { left: number; right: number }): void {
  element.getBoundingClientRect = () => new DOMRect(box.left, 0, box.right - box.left, 20);
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollWidth: number; clientWidth: number; scrollLeft?: number },
): void {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: metrics.scrollWidth });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: metrics.clientWidth });
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    value: metrics.scrollLeft ?? 0,
  });
}

describe('MarkdownTableScroller', () => {
  test('a table that fits adds no region, no tab stop, and no cue', () => {
    const { container } = render(MarkdownTableScroller, { props: { html: tableHtml } });
    const scroller = container.querySelector('.message-markdown-table-scroller');

    expect(scroller?.querySelector('table')).not.toBeNull();
    expect(scroller?.getAttribute('role')).toBeNull();
    expect(scroller?.getAttribute('aria-label')).toBeNull();
    expect(scroller?.hasAttribute('tabindex')).toBe(false);
    expect(container.querySelector('.message-markdown-table-cue')).toBeNull();
  });

  test('an overflowing table makes its scroller a named region with a column cue', async () => {
    const { container } = render(MarkdownTableScroller, { props: { html: tableHtml } });
    const scroller = container.querySelector<HTMLElement>('.message-markdown-table-scroller');
    if (scroller === null) throw new Error('The table scroller did not render.');

    setLayout(scroller, { left: 0, right: 254 });
    const cells = scroller.querySelectorAll('thead th');
    const cellBoxes = [
      { left: 0, right: 115 },
      { left: 115, right: 230 },
      { left: 230, right: 345 },
      { left: 345, right: 460 },
    ];
    cells.forEach((cell, index) => setLayout(cell, cellBoxes[index] ?? { left: 0, right: 0 }));
    setScrollMetrics(scroller, { scrollWidth: 460, clientWidth: 254 });
    await fireEvent.scroll(scroller);

    await waitFor(() => expect(scroller.getAttribute('role')).toBe('region'));
    expect(scroller.getAttribute('aria-label')).toBe('Scrollable table');
    expect(scroller.getAttribute('tabindex')).toBe('0');
    // The table itself keeps its own semantics; the region is the scroller around it.
    expect(scroller.querySelector('table')?.getAttribute('role')).toBeNull();

    const cue = container.querySelector('.message-markdown-table-cue');
    expect(cue?.textContent).toContain('+2 columns');
    expect(cue?.textContent).toContain('Scroll to see all columns');
    expect(scroller.getAttribute('aria-describedby')).toBe(cue?.id ?? 'missing');
    expect(
      container.querySelector('.message-markdown-table-frame')?.hasAttribute('data-fade-end'),
    ).toBe(true);

    // Scrolled to the end, the cue stays while the table still overflows, and the fade clears.
    setScrollMetrics(scroller, { scrollWidth: 460, clientWidth: 254, scrollLeft: 206 });
    await fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(
        container.querySelector('.message-markdown-table-frame')?.hasAttribute('data-fade-end'),
      ).toBe(false),
    );
    expect(container.querySelector('.message-markdown-table-cue')).not.toBeNull();

    // Widened past the threshold, the region and its tab stop go away again.
    setScrollMetrics(scroller, { scrollWidth: 460, clientWidth: 460 });
    await fireEvent.scroll(scroller);
    await waitFor(() => expect(scroller.hasAttribute('tabindex')).toBe(false));
    expect(scroller.getAttribute('role')).toBeNull();
    expect(container.querySelector('.message-markdown-table-cue')).toBeNull();
  });

  test('counts the columns outside the visible span on either side', () => {
    const scroller = document.createElement('div');
    scroller.innerHTML = tableHtml;
    setLayout(scroller, { left: 100, right: 300 });
    const cellBoxes = [
      { left: 0, right: 100 },
      { left: 100, right: 200 },
      { left: 200, right: 300 },
      { left: 300, right: 400 },
    ];
    scroller
      .querySelectorAll('thead th')
      .forEach((cell, index) => setLayout(cell, cellBoxes[index] ?? { left: 0, right: 0 }));

    expect(countHiddenColumns(scroller)).toBe(2);
  });

  test('does not count a first column that starts exactly at the scroller edge as hidden', () => {
    const scroller = document.createElement('div');
    scroller.innerHTML = tableHtml;
    setLayout(scroller, { left: 100, right: 300 });
    const cells = scroller.querySelectorAll('th');
    cells.forEach((cell, index) => {
      const left = 100 + index * 100;
      setLayout(cell, { left, right: left + 100 });
    });

    expect(countHiddenColumns(scroller)).toBe(2);
  });
});
