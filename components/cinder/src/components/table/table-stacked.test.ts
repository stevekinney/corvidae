/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync, tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { stripCinderComponentsLayer } from '../../test/css.ts';
import { DEFAULT_TEST_VIEWPORT, setTestViewportWidth } from '../../test/viewport.ts';

setupHappyDom();

const { render, fireEvent } = await import('@testing-library/svelte');
const { stubCutLayout } = await import('../../_internal/cut-layout-stub.ts');
const { default: Wrapper } = await import('../../test/fixtures/table-fixture.svelte');
const { default: CardFixture } = await import('./table-card.fixture.svelte');
const { default: DescriptionList } = await import('../description-list/description-list.svelte');

afterEach(() => {
  setTestViewportWidth(DEFAULT_TEST_VIEWPORT.width);
});

const columns = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'status', label: 'Status' },
];
const rows = [
  { id: '1', cells: ['Refund order 4471', 'Waiting on you'] },
  { id: '2', cells: ['Daily summary', 'Done'] },
];

function bodyCells(container: Element): HTMLTableCellElement[] {
  return Array.from(container.querySelectorAll<HTMLTableCellElement>('tbody td'));
}

const controlCells = { controls: true } as const;

describe('Table stackBelow', () => {
  test('stacks below 640px and labels each body cell with its column header', () => {
    setTestViewportWidth(375);
    const { container } = render(Wrapper, { columns, rows, cellProps: controlCells });
    flushSync();

    const table = container.querySelector('table');
    expect(table?.hasAttribute('data-cinder-stacked')).toBe(true);
    expect(
      bodyCells(container).map((cell) => cell.getAttribute('data-cinder-stack-label')),
    ).toEqual(['Name', 'Status', 'Name', 'Status']);
  });

  test('keeps the table layout at tablet and desktop widths', () => {
    setTestViewportWidth(768);
    const { container } = render(Wrapper, { columns, rows, cellProps: controlCells });
    flushSync();

    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(false);
    expect(container.querySelector('[data-cinder-stack-label]')).toBeNull();
  });

  test('follows the viewport across the breakpoint', async () => {
    const { container } = render(Wrapper, { columns, rows, cellProps: controlCells });
    const table = container.querySelector('table');
    expect(table?.hasAttribute('data-cinder-stacked')).toBe(false);

    setTestViewportWidth(375);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === true);
    expect(bodyCells(container)[1]?.getAttribute('data-cinder-stack-label')).toBe('Status');

    setTestViewportWidth(1024);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === false);
  });

  test('labels rows added while stacked', async () => {
    setTestViewportWidth(375);
    const { container, rerender } = render(Wrapper, { columns, rows, cellProps: controlCells });
    flushSync();

    await rerender({
      columns,
      rows: [...rows, { id: '3', cells: ['Weekly report', 'Failed'] }],
      cellProps: controlCells,
    });
    await tick();
    await waitUntil(() => bodyCells(container).length === 6);
    await waitUntil(
      () => bodyCells(container)[5]?.getAttribute('data-cinder-stack-label') === 'Status',
    );
  });

  test('skips the label for a header cell with no text, such as the selection column', () => {
    setTestViewportWidth(375);
    const { container } = render(Wrapper, {
      columns,
      rows,
      selectable: true,
      cellProps: controlCells,
    });
    flushSync();

    const firstRowCells = Array.from(
      container.querySelectorAll<HTMLTableCellElement>('tbody tr:first-child > *'),
    );
    expect(firstRowCells.map((cell) => cell.getAttribute('data-cinder-stack-label'))).toEqual([
      null,
      'Name',
      'Status',
    ]);
  });

  test('keeps explicit table roles while stacked and removes them after', async () => {
    // Start wide: happy-dom never fires `change` on a MediaQueryList created
    // while it already matches, so a table mounted narrow would never see the
    // viewport widen again. Browsers do not share the quirk.
    const { container } = render(Wrapper, { columns, rows, cellProps: controlCells });
    const table = container.querySelector('table');
    expect(table?.hasAttribute('role')).toBe(false);

    setTestViewportWidth(375);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === true);
    expect(table?.getAttribute('role')).toBe('table');
    expect(container.querySelector('thead')?.getAttribute('role')).toBe('rowgroup');
    expect(container.querySelector('tbody tr')?.getAttribute('role')).toBe('row');
    expect(container.querySelector('thead th')?.getAttribute('role')).toBe('columnheader');
    expect(container.querySelector('tbody td')?.getAttribute('role')).toBe('cell');

    setTestViewportWidth(1024);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === false);
    expect(container.querySelector('[role="cell"], [role="row"], [role="table"]')).toBeNull();
  });

  test('stackBelow={false} keeps the table layout on a phone', () => {
    setTestViewportWidth(375);
    const { container } = render(Wrapper, {
      columns,
      rows,
      stackBelow: false,
      cellProps: controlCells,
    });
    flushSync();

    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(false);
  });

  test('a custom stackBelow moves the breakpoint', () => {
    setTestViewportWidth(768);
    const { container } = render(Wrapper, {
      columns,
      rows,
      stackBelow: '1024px',
      cellProps: controlCells,
    });
    flushSync();

    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(true);
  });

  test('rejects a stackBelow that is not a CSS length', () => {
    expect(() =>
      render(Wrapper, { columns, rows, stackBelow: 'phone', cellProps: controlCells }),
    ).toThrow('Table stackBelow must be a CSS length such as "640px", or false.');
  });

  test('the stacked styles hide the header, put the controls on a line of their own, and size them to 44px', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./table.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-table\[data-cinder-stacked\] > \.cinder-table__header \{[^}]*clip-path: inset\(50%\);/,
    );
    expect(css).toMatch(
      /\.cinder-table\[data-cinder-stacked\]\s+\.cinder-table__body\s+\.cinder-table__cell\[data-cinder-controls\] \{\s*order: 2;[^}]*min-block-size: 2\.75rem;/,
    );
    expect(css).toMatch(
      /\.cinder-table\[data-cinder-stacked\]\s+\.cinder-table__body\s+\.cinder-table__cell\[data-cinder-controls='fit'\]\[data-cinder-stack-label\]::before \{\s*content: attr\(data-cinder-stack-label\);/,
    );
    expect(css).toMatch(
      /\.cinder-table-scroll > \.cinder-table\[data-cinder-stacked\] \{\s*flex: 1 1 auto;\s*min-inline-size: 0;/,
    );
    // A cell's detail flows with its content, and a card drops it so line one is the name and its facts.
    expect(css).toMatch(/\.cinder-table__cell-detail \{\s*display: contents;/);
    expect(css).toMatch(
      /\.cinder-table\[data-cinder-stacked\] \.cinder-table__cell-detail \{\s*display: none;/,
    );
    // Only an unbroken string breaks, not every character.
    expect(css).toMatch(/overflow-wrap: break-word;/);
    expect(css).not.toMatch(/overflow-wrap: anywhere;/);
  });
});

describe('Table scroll and stack by container', () => {
  const ORIGINAL_RESIZE_OBSERVER = globalThis.ResizeObserver;
  const ORIGINAL_RECT = Element.prototype.getBoundingClientRect;

  class StubResizeObserver {
    static instances: StubResizeObserver[] = [];
    target: Element | null = null;
    constructor(readonly callback: ResizeObserverCallback) {
      StubResizeObserver.instances.push(this);
    }
    observe(target: Element): void {
      this.target = target;
    }
    unobserve(): void {}
    disconnect(): void {
      this.target = null;
    }
    /** Reports `width` for every observed scroll box. */
    static resize(width: number): void {
      for (const instance of StubResizeObserver.instances) {
        if (!instance.target?.classList.contains('cinder-table-scroll')) continue;
        instance.callback(
          [{ target: instance.target, contentRect: { width } } as ResizeObserverEntry],
          instance,
        );
      }
    }
  }

  function measureScrollBoxes(width: number): void {
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const measured = this.classList.contains('cinder-table-scroll') ? width : 0;
      return {
        width: measured,
        height: 0,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: measured,
        bottom: 0,
        toJSON: () => ({}),
      };
    };
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: ORIGINAL_RESIZE_OBSERVER,
    });
    Element.prototype.getBoundingClientRect = ORIGINAL_RECT;
    StubResizeObserver.instances = [];
  });

  function useStubObserver(): void {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: StubResizeObserver,
    });
  }

  test('scrolls by default, in a box that owns the frame', () => {
    const { container } = render(Wrapper, { columns, rows });
    const box = container.querySelector('.cinder-table-scroll');
    expect(box?.querySelector(':scope > table')).not.toBeNull();
    expect(box?.classList.contains('cinder-_scroll-fade-inline-end')).toBe(true);
  });

  test('a table with no controls never stacks, even on a phone', () => {
    setTestViewportWidth(375);
    const { container } = render(Wrapper, { columns, rows });
    flushSync();

    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(false);
    expect(container.querySelector('[data-cinder-stack-label]')).toBeNull();
  });

  test('stacks by its own container width, not the window width', async () => {
    useStubObserver();
    measureScrollBoxes(500);
    // A wide window and a narrow column: the table stacks.
    setTestViewportWidth(1280);
    const { container } = render(Wrapper, { columns, rows, cellProps: controlCells });
    const table = container.querySelector('table');
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === true);

    measureScrollBoxes(900);
    StubResizeObserver.resize(900);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === false);
  });

  test('stays in the table layout in a wide container inside a narrow window', async () => {
    useStubObserver();
    measureScrollBoxes(900);
    setTestViewportWidth(375);
    const { container } = render(Wrapper, { columns, rows, cellProps: controlCells });
    flushSync();
    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(false);
  });

  test('compares the container with a rem breakpoint against the root font size', async () => {
    useStubObserver();
    measureScrollBoxes(500);
    const { container } = render(Wrapper, {
      columns,
      rows,
      cellProps: controlCells,
      stackBelow: '40rem',
    });
    flushSync();
    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(true);
  });

  test('marks a fit control so its column label can sit beside it', () => {
    const { container } = render(Wrapper, { columns, rows, cellProps: { controls: 'fit' } });
    expect(container.querySelector('tbody td')?.getAttribute('data-cinder-controls')).toBe('fit');
  });
});

describe('Table fit stacks into cards', () => {
  const cardCells = (container: Element, selector: string): Element[] =>
    Array.from(container.querySelectorAll(`tbody ${selector}`));
  const hasAttribute = (element: Element | null | undefined, name: string): boolean =>
    element?.hasAttribute(name) === true;

  test('a fit table stacks below stackBelow as a card layout and marks its frame', () => {
    setTestViewportWidth(375);
    const { container } = render(CardFixture, {});
    flushSync();

    expect(hasAttribute(container.querySelector('table'), 'data-cinder-stacked')).toBe(true);
    expect(hasAttribute(container.querySelector('table'), 'data-cinder-stack-card')).toBe(true);
    expect(
      hasAttribute(container.querySelector('.cinder-table-scroll'), 'data-cinder-stack-card'),
    ).toBe(true);
  });

  test('a fit table keeps the table layout at tablet width and on stackBelow={false}', () => {
    setTestViewportWidth(768);
    const tablet = render(CardFixture, {});
    expect(hasAttribute(tablet.container.querySelector('table'), 'data-cinder-stacked')).toBe(
      false,
    );
    setTestViewportWidth(375);
    const phone = render(CardFixture, { stackBelow: false });
    expect(hasAttribute(phone.container.querySelector('table'), 'data-cinder-stacked')).toBe(false);
  });

  test('a table that is not fitted and has no controls does not stack', () => {
    setTestViewportWidth(375);
    const { container } = render(CardFixture, { fit: false });
    flushSync();
    expect(hasAttribute(container.querySelector('table'), 'data-cinder-stacked')).toBe(false);
    expect(container.querySelector('[data-cinder-stack-title]')).toBeNull();
  });

  test('a table that is not fitted with controls keeps the control-line layout, not the card', () => {
    setTestViewportWidth(375);
    const { container } = render(CardFixture, { fit: false, controls: true });
    flushSync();
    expect(hasAttribute(container.querySelector('table'), 'data-cinder-stacked')).toBe(true);
    expect(hasAttribute(container.querySelector('table'), 'data-cinder-stack-card')).toBe(false);
  });

  test('a fit table with a control that fills its cell (Agent Access) keeps the control-line layout', () => {
    setTestViewportWidth(375);
    const { container } = render(CardFixture, { controls: true });
    flushSync();
    expect(hasAttribute(container.querySelector('table'), 'data-cinder-stacked')).toBe(true);
    expect(hasAttribute(container.querySelector('table'), 'data-cinder-stack-card')).toBe(false);
    expect(
      hasAttribute(container.querySelector('.cinder-table-scroll'), 'data-cinder-stack-card'),
    ).toBe(false);
  });

  test('a fit table that stacks as flat rows stacks only below 26rem; the control layout keeps 640px', () => {
    setTestViewportWidth(500);
    const flat = render(CardFixture, {});
    flushSync();
    expect(hasAttribute(flat.container.querySelector('table'), 'data-cinder-stacked')).toBe(false);
    flat.unmount();

    const control = render(CardFixture, { controls: true });
    flushSync();
    expect(hasAttribute(control.container.querySelector('table'), 'data-cinder-stacked')).toBe(
      true,
    );
    control.unmount();

    setTestViewportWidth(400);
    const narrow = render(CardFixture, {});
    flushSync();
    expect(hasAttribute(narrow.container.querySelector('table'), 'data-cinder-stack-card')).toBe(
      true,
    );
  });

  test('a fit table whose control keeps its size is a card', () => {
    setTestViewportWidth(375);
    const { container } = render(CardFixture, { controls: 'fit' });
    flushSync();
    expect(hasAttribute(container.querySelector('table'), 'data-cinder-stack-card')).toBe(true);
  });

  test('marks the title cell, labels the other cells, and marks the empty ones', async () => {
    setTestViewportWidth(375);
    const { container } = render(CardFixture, {});
    flushSync();
    await waitUntil(() => container.querySelector('[data-cinder-stack-title]') !== null);

    expect(cardCells(container, '[data-cinder-stack-title]').map((cell) => cell.tagName)).toEqual([
      'TH',
      'TH',
    ]);
    const firstRow = Array.from(container.querySelectorAll('tbody tr:first-child > *'));
    expect(firstRow.map((cell) => cell.getAttribute('data-cinder-stack-label'))).toEqual([
      'Model',
      'Allowed',
      'Abilities',
      'Last run',
    ]);
    // The second row has no abilities: that cell is not drawn.
    expect(
      cardCells(container, '[data-cinder-stack-empty]').map((cell) =>
        cell.getAttribute('data-cinder-stack-label'),
      ),
    ).toEqual(['Abilities']);
    expect(container.querySelector('tbody tr:first-child [data-cinder-stack-empty]')).toBeNull();
  });

  test('a title cell that is not a th is the first cell that is not empty and has no control', async () => {
    setTestViewportWidth(375);
    const { container } = render(Wrapper, {
      columns: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      rows: [{ id: '1', cells: ['', 'Second'] }],
      fit: true,
    });
    flushSync();
    await waitUntil(() => container.querySelector('[data-cinder-stack-title]') !== null);
    expect(container.querySelector('[data-cinder-stack-title]')?.textContent).toBe('Second');
  });

  test('a title the clamp cuts takes the tab stop and opens a tooltip with its whole text', async () => {
    const restore = stubCutLayout(true);
    try {
      setTestViewportWidth(375);
      const { container } = render(CardFixture, {});
      flushSync();
      await waitUntil(() => container.querySelector('.cinder-table__cell-title') !== null);
      const title = container.querySelector('.cinder-table__cell-title') as HTMLElement;
      expect(title.textContent).toContain('Claude Opus');
      await waitUntil(() => title.getAttribute('tabindex') === '0');
      await fireEvent.focus(title);
      await waitUntil(() => document.querySelector('[role="tooltip"]') !== null);
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Claude Opus');
    } finally {
      restore();
    }
  });

  test('a title the clamp does not cut has no tab stop and no tooltip', async () => {
    const restore = stubCutLayout(false);
    try {
      setTestViewportWidth(375);
      const { container } = render(CardFixture, {});
      flushSync();
      await waitUntil(() => container.querySelector('.cinder-table__cell-title') !== null);
      const title = container.querySelector('.cinder-table__cell-title') as HTMLElement;
      expect(title.hasAttribute('tabindex')).toBe(false);
      await fireEvent.focus(title);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      restore();
    }
  });

  test('a table that is not stacked clamps the row header too, with no card marks', () => {
    setTestViewportWidth(1280);
    const { container } = render(CardFixture, {});
    flushSync();
    expect(container.querySelector('.cinder-table__cell-title')).not.toBeNull();
    expect(container.querySelector('[data-cinder-stack-title]')).toBeNull();
  });

  test('a row header that opts out of the clamp is drawn bare', async () => {
    const { default: RowHeader } = await import('./table-row-header.fixture.svelte');
    const clamped = render(RowHeader, {});
    flushSync();
    expect(clamped.container.querySelector('th .cinder-table__cell-title')).not.toBeNull();
    clamped.unmount();
    const bare = render(RowHeader, { clamp: false });
    flushSync();
    expect(bare.container.querySelector('th')?.textContent?.trim()).toBe('Run 4471');
    expect(bare.container.querySelector('.cinder-table__cell-title')).toBeNull();
  });

  test('the two-line clamp belongs to every fit table, not only the stacked one', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./table.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-table\[data-cinder-fit\] \.cinder-table__cell-title \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/,
    );
  });

  test('a stacked sortable table offers one sort control and keeps the header buttons out of the tab order', async () => {
    setTestViewportWidth(375);
    const { container } = render(CardFixture, { sortable: true });
    flushSync();
    await waitUntil(() => container.querySelector('.cinder-table__stack-sort') !== null);
    expect(container.querySelectorAll('.cinder-table__stack-sort')).toHaveLength(1);
    expect(container.querySelector('.cinder-table__sort-button')?.getAttribute('tabindex')).toBe(
      '-1',
    );
  });

  test('the sort control is a compact ghost select that names its cue, with a 44px hit area', async () => {
    setTestViewportWidth(375);
    const { container } = render(CardFixture, { sortable: true });
    flushSync();
    await waitUntil(() => container.querySelector('.cinder-table__stack-sort') !== null);
    const select = container.querySelector('.cinder-table__stack-sort select') as HTMLSelectElement;
    expect(select.getAttribute('data-cinder-variant')).toBe('ghost');
    const labels = Array.from(select.options)
      .map((option) => option.textContent?.trim() ?? '')
      .filter((label) => label !== '' && label !== 'Sort by');
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label.startsWith('Sort: '))).toBe(true);
    expect(labels.some((label) => /^Sort: \w.* ascending$/.test(label))).toBe(true);

    // A press in the hit area outside the drawn select opens it; one on the select is left alone.
    const picked: string[] = [];
    select.showPicker = () => picked.push('open');
    const hit = container.querySelector('.cinder-table__stack-sort-hit') as HTMLElement;
    await fireEvent.click(hit);
    expect(picked).toEqual(['open']);
    await fireEvent.click(select);
    expect(picked).toEqual(['open']);

    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./table.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-table__stack-sort-hit \{[^}]*padding-block: var\(--cinder-space-1\);/,
    );
    expect(css).toMatch(
      /\.cinder-table__stack-sort-hit \.cinder-select\[data-cinder-variant='ghost'\]\[data-cinder-size\] \{[^}]*min-block-size: 2\.25rem;[^}]*max-block-size: 2\.25rem;/,
    );
  });

  test('the stacked description and end value are muted, in the phone row type of a stacked list item', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./table.css', import.meta.url)).text(),
    ).replace(/\s+/g, ' ');
    const body = (selector: string): string => {
      const escaped = selector
        .replace(/\s+/g, ' ')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/ /g, '\\s+');
      return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    };
    // The sibling rule decides the layout only: a colour on it would outrank the muted parts.
    const sibling = body(
      '.cinder-table[data-cinder-stack-card]\n    .cinder-table__body\n    .cinder-table__cell:not([data-cinder-controls])\n    ~ .cinder-table__cell:not([data-cinder-controls])',
    );
    expect(sibling).toContain('flex: 0 1 auto;');
    expect(sibling).not.toMatch(/color:/);
    const prose = body(
      ".cinder-table[data-cinder-stack-card]\n    .cinder-table__body\n    .cinder-table__cell[data-cinder-stack='plain']",
    );
    expect(prose).toContain('color: var(--cinder-text-muted);');
    const end = body(
      ".cinder-table[data-cinder-stack-card]\n    .cinder-table__body\n    .cinder-table__cell[data-cinder-stack='end']",
    );
    expect(end).toContain('color: var(--cinder-text-subtle);');
    expect(end).toContain('font-size: var(--cinder-text-xs);');
    const title = body(
      '.cinder-table[data-cinder-stack-card]\n    .cinder-table__body\n    .cinder-table__cell[data-cinder-stack-title]',
    );
    expect(title).toContain('font-size: var(--cinder-text-base);');
    expect(title).toContain('font-weight: var(--cinder-font-semibold);');
  });

  test('the card styles are scoped to the card marker and draw no frame', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./table.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-table-scroll:has\(> \.cinder-table\[data-cinder-stack-card\]\) \{[^}]*border: 0;[^}]*border-radius: 0;/,
    );
    expect(css).toMatch(
      /\.cinder-table\[data-cinder-stack-card\]\s+\.cinder-table__body\s+\.cinder-table__row \{[^}]*display: grid;/,
    );
    expect(css).toMatch(/\[data-cinder-stack-empty\][^{]*\{\s*display: none;/);
  });
});

describe('DescriptionList stack', () => {
  const items = [
    { term: 'Order ID', definition: '4471' },
    { term: 'Reason', definition: 'Damaged' },
  ];

  test('marks the list stacked only when asked', () => {
    const stacked = render(DescriptionList, { items, variant: 'two-column', stack: true });
    expect(stacked.container.querySelector('dl')?.hasAttribute('data-cinder-stacked')).toBe(true);

    const sideBySide = render(DescriptionList, { items, variant: 'two-column' });
    expect(sideBySide.container.querySelector('dl')?.hasAttribute('data-cinder-stacked')).toBe(
      false,
    );
  });

  test('collapses the two-column grid to one column when stacked', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('../description-list/description-list.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-description-list\[data-cinder-variant='two-column'\]\[data-cinder-stacked\]\s+\.cinder-description-list__row \{\s*grid-template-columns: 1fr;/,
    );
  });
});
