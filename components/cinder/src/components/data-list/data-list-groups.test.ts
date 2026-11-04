/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import type { StatusListRow } from '../../test/fixtures/status-list-fixture.svelte';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: StatusListFixture } =
  await import('../../test/fixtures/status-list-fixture.svelte');
const { captureScrollAnchor, findScrollContainer } =
  await import('../../_internal/scroll-anchor.ts');

const stylesheet = readFileSync(new URL('./data-list.css', import.meta.url), 'utf8');

const row = (id: string, day: string, title = id): StatusListRow => ({
  id,
  title,
  day,
  status: 'Done',
  time: '10:00 AM',
  meta: 'Chat',
});

describe('DataList day groups', () => {
  test('consecutive rows with one key share a header band that names a nested list', () => {
    const { container } = render(StatusListFixture, {
      props: {
        grouped: true,
        rows: [row('a', 'Today'), row('b', 'Today'), row('c', 'Yesterday')],
      },
    });
    const groups = [...container.querySelectorAll('.cinder-data-list-group')];
    expect(groups).toHaveLength(2);
    expect(groups[0]?.querySelectorAll('.cinder-stacked-list-item')).toHaveLength(2);
    expect(groups[1]?.querySelectorAll('.cinder-stacked-list-item')).toHaveLength(1);

    const header = groups[0]?.querySelector('.cinder-data-list-group__header');
    expect(header?.querySelector('.cinder-data-list-group__label')?.textContent).toBe('Today');
    expect(header?.querySelector('.cinder-data-list-group__detail')?.textContent).toBe(
      'Central time',
    );
    const nested = groups[0]?.querySelector('ul');
    expect(nested?.getAttribute('role')).toBe('list');
    expect(nested?.getAttribute('aria-labelledby')).toBe(header?.getAttribute('id'));
  });

  test('a key that comes back after another group starts a new group instead of merging', () => {
    const { container } = render(StatusListFixture, {
      props: { grouped: true, rows: [row('a', 'Today'), row('b', 'Yesterday'), row('c', 'Today')] },
    });
    const labels = [...container.querySelectorAll('.cinder-data-list-group__label')].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(['Today', 'Yesterday', 'Today']);
    const ids = [...container.querySelectorAll('.cinder-data-list-group__header')].map((header) =>
      header.getAttribute('id'),
    );
    expect(new Set(ids).size).toBe(3);
  });

  test('without groupBy the rows stay direct children of the list', () => {
    const { container } = render(StatusListFixture, {
      props: { rows: [row('a', 'Today'), row('b', 'Today')] },
    });
    expect(container.querySelector('.cinder-data-list-group')).toBeNull();
    expect(
      container.querySelectorAll('.cinder-data-list > .cinder-stacked-list-item'),
    ).toHaveLength(2);
  });

  test('the list wraps unbroken values anywhere by default and a group draws its own divider', () => {
    expect(stylesheet).toMatch(/\.cinder-data-list \{[^}]*overflow-wrap:\s*anywhere/s);
    expect(stylesheet).toMatch(/__items > :last-child\s*\{\s*border-block-end:\s*0/);
    expect(stylesheet).toMatch(/__header \{[^}]*background:\s*var\(--cinder-surface-inset\)/s);
  });
});

describe('DataList live insertion', () => {
  test('announces rows inserted while the list is shown, politely, and nothing on first render', async () => {
    const { container, rerender } = render(StatusListFixture, {
      props: { announce: true, grouped: true, rows: [row('a', 'Today')] },
    });
    const region = container.querySelector('.cinder-data-list-live [role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent?.trim()).toBe('');

    await rerender({ rows: [row('n', 'Today', 'Look up order 4475'), row('a', 'Today')] });
    expect(region?.textContent?.trim()).toBe('1 new run');
    // The new row is at the top of its group, and the list keeps the other row.
    const titles = [...container.querySelectorAll('.cinder-stacked-list-item__title')].map(
      (title) => title.textContent?.trim(),
    );
    expect(titles).toEqual(['Look up order 4475', 'a']);

    await rerender({
      rows: [row('m', 'Today'), row('o', 'Today'), row('n', 'Today'), row('a', 'Today')],
    });
    expect(
      container.querySelector('.cinder-data-list-live [role="status"]')?.textContent?.trim(),
    ).toBe('2 new runs');
  });

  test('a removed or reordered row is not announced', async () => {
    const { container, rerender } = render(StatusListFixture, {
      props: { announce: true, rows: [row('a', 'Today'), row('b', 'Today')] },
    });
    await rerender({ rows: [row('b', 'Today'), row('a', 'Today')] });
    await rerender({ rows: [row('b', 'Today')] });
    expect(
      container.querySelector('.cinder-data-list-live [role="status"]')?.textContent?.trim(),
    ).toBe('');
  });

  test('a list with no insertionAnnouncement draws no live region', () => {
    const { container } = render(StatusListFixture, { props: { rows: [row('a', 'Today')] } });
    expect(container.querySelector('.cinder-data-list-live')).toBeNull();
  });

  test('the live region takes no space and every list child is still a list item', () => {
    expect(stylesheet).toMatch(/\.cinder-data-list-live\s*\{[^}]*position:\s*absolute/);
    const { container } = render(StatusListFixture, {
      props: { announce: true, rows: [row('a', 'Today')] },
    });
    const list = container.querySelector('.cinder-data-list');
    expect([...(list?.children ?? [])].every((child) => child.tagName === 'LI')).toBe(true);
  });
});

describe('DataList live insertion status strip', () => {
  test('draws nothing until rows arrive, then marks the live region as the visible strip', async () => {
    const { container, rerender } = render(StatusListFixture, {
      props: { announce: true, grouped: true, rows: [row('a', 'Today')] },
    });
    const live = container.querySelector('.cinder-data-list-live');
    expect(live?.hasAttribute('data-announced')).toBe(false);

    await rerender({ rows: [row('n', 'Today', 'Look up order 4475'), row('a', 'Today')] });
    expect(live?.hasAttribute('data-announced')).toBe(true);
    // The drawn text and the spoken text are the same polite region.
    expect(live?.querySelector('[role="status"]')?.textContent?.trim()).toBe('1 new run');
    expect(live?.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  });

  test('an announced strip is drawn in flow as the accent band above the first group', () => {
    const rule = stylesheet.match(/\.cinder-data-list-live\[data-announced\]\s*\{([^}]*)\}/)?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/position:\s*static/);
    expect(rule).toMatch(/clip-path:\s*none/);
    expect(rule).toMatch(/overflow:\s*visible/);
    expect(rule).toMatch(/background:\s*var\(--cinder-accent-background\)/);
    expect(rule).toMatch(/color:\s*var\(--cinder-accent-text\)/);
    expect(rule).not.toMatch(/display:\s*none/);
  });
});

describe('scroll anchor', () => {
  function listWithRows(tops: number[]) {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const list = document.createElement('ul');
    scroller.append(list);
    document.body.append(scroller);
    const rows = tops.map((top) => {
      const item = document.createElement('li');
      let currentTop = top;
      item.getBoundingClientRect = () =>
        ({ top: currentTop, bottom: currentTop + 50, height: 50 }) as DOMRect;
      Object.defineProperty(item, 'moveTo', { value: (next: number) => (currentTop = next) });
      list.append(item);
      return item as HTMLLIElement & { moveTo: (next: number) => void };
    });
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
    return { scroller, list, rows };
  }

  test('finds the nearest vertically scrolling ancestor', () => {
    const { scroller, list } = listWithRows([0]);
    expect(findScrollContainer(list)).toBe(scroller);
    scroller.remove();
  });

  test('scrolls by however far the first visible row moved when rows arrive above it', () => {
    const { scroller, list, rows } = listWithRows([-120, -70, -20, 30]);
    scroller.scrollTop = 200;
    const restore = captureScrollAnchor(list);
    expect(restore).toBeDefined();
    // A row was inserted above: every row below it moved down by 50px.
    for (const item of rows) item.moveTo(item.getBoundingClientRect().top + 50);
    restore?.();
    expect(scroller.scrollTop).toBe(250);
    scroller.remove();
  });

  test('never anchors on the live region, which takes no space above the first row', () => {
    const { scroller, list, rows } = listWithRows([-120, -70, -20, 30]);
    const live = document.createElement('li');
    live.setAttribute('role', 'presentation');
    live.className = 'cinder-data-list-live';
    // Zero height at the top of the list, still below the scroller's top edge.
    live.getBoundingClientRect = () => ({ top: 10, bottom: 10, height: 0 }) as DOMRect;
    list.prepend(live);
    scroller.scrollTop = 200;
    const restore = captureScrollAnchor(list);
    expect(restore).toBeDefined();
    for (const item of rows) item.moveTo(item.getBoundingClientRect().top + 50);
    restore?.();
    expect(scroller.scrollTop).toBe(250);
    scroller.remove();
  });

  test('does nothing when the browser already kept the row in place', () => {
    const { scroller, list } = listWithRows([-20, 30]);
    scroller.scrollTop = 200;
    captureScrollAnchor(list)?.();
    expect(scroller.scrollTop).toBe(200);
    scroller.remove();
  });

  test('leaves a list scrolled to the top alone, so a new row is seen', () => {
    const { scroller, list } = listWithRows([0, 50]);
    scroller.scrollTop = 0;
    expect(captureScrollAnchor(list)).toBeUndefined();
    scroller.remove();
  });

  test('uses the window scroll fallback when no ancestor scrolls', () => {
    const list = document.createElement('ul');
    const row = document.createElement('li');
    let top = 30;
    row.getBoundingClientRect = () => ({ top, bottom: top + 50, height: 50 }) as DOMRect;
    list.append(row);
    document.body.append(list);

    const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const scrollByDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollBy');
    let scrolledBy = 0;
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 200 });
    Object.defineProperty(window, 'scrollBy', {
      configurable: true,
      value: (_x: number, y: number) => {
        scrolledBy += y;
      },
    });

    try {
      const restore = captureScrollAnchor(list);
      expect(restore).toBeDefined();
      top += 40;
      restore?.();
      expect(scrolledBy).toBe(40);
    } finally {
      if (scrollYDescriptor) Object.defineProperty(window, 'scrollY', scrollYDescriptor);
      else delete (window as { scrollY?: number }).scrollY;
      if (scrollByDescriptor) Object.defineProperty(window, 'scrollBy', scrollByDescriptor);
      else delete (window as { scrollBy?: (x: number, y: number) => void }).scrollBy;
      list.remove();
    }
  });
});
