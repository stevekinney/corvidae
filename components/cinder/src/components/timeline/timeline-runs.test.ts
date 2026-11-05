/// <reference lib="dom" />
/**
 * COR-2018 (B10, rows 72k, 73f, 73g and 73m): the Schedule detail "Runs" list below Now. A past run
 * is a status-first row that links as a whole, with its duration and a chevron; a skipped
 * occurrence's time is crossed out; the missed-runs band reports each time it is opened or closed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import { buildTimelineRenderPlan } from './timeline-groups.ts';
import type { TimelineEntry } from './timeline.types.ts';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/timeline-runs-fixture.svelte');

const css = readFileSync(new URL('./timeline.css', import.meta.url), 'utf8');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function runRow(container: HTMLElement, index: number): HTMLElement {
  const rows = container.querySelectorAll<HTMLElement>(
    'li.cinder-timeline-item[data-cinder-kind="run"]',
  );
  const row = rows[index];
  if (row === undefined) throw new Error(`no run row ${String(index)}`);
  return row;
}

describe('Timeline run entry (rows 72k and 73f)', () => {
  test('leads with the status dot and word, then the bold time, then the muted second line', () => {
    const { container } = render(Fixture, {});
    const row = runRow(container, 0);
    expect(row.querySelector('.cinder-stacked-list-item__status')?.textContent?.trim()).toBe(
      'Running',
    );
    expect(row.querySelector('.cinder-stacked-list-item__title time')?.textContent).toBe(
      'Mon Nov 2, 10:45 AM',
    );
    expect(
      row.querySelector('.cinder-stacked-list-item__title time')?.getAttribute('datetime'),
    ).toBe('2026-11-02T16:45:00Z');
    expect(row.querySelector('.cinder-stacked-list-item__meta')?.textContent).toBe(
      'Started with Run now · Collecting merged changes',
    );
  });

  test('the whole row is the link, and the duration and a chevron end it', () => {
    const { container } = render(Fixture, {});
    const row = runRow(container, 1);
    const link = row.querySelector<HTMLAnchorElement>('a.cinder-stacked-list-item__title-link');
    expect(link?.getAttribute('href')).toBe('/runs/done');
    expect(row.querySelector('.cinder-timeline-item__duration')?.textContent).toBe('14 s');
    expect(row.querySelector('.cinder-stacked-list-item__trailing svg')).not.toBeNull();
    expect(row.querySelector('.cinder-stacked-list-item__meta')).toBeNull();
  });

  test('a run with no link and no duration draws neither a chevron nor a duration', () => {
    const { container } = render(Fixture, {});
    const row = runRow(container, 2);
    expect(row.querySelector('a')).toBeNull();
    expect(row.querySelector('.cinder-timeline-item__duration')).toBeNull();
    expect(row.querySelector('svg')).toBeNull();
  });

  test('draws no marker, connector or timestamp header of an event', () => {
    const { container } = render(Fixture, {});
    const row = runRow(container, 0);
    expect(row.querySelector('.cinder-timeline-item__marker')).toBeNull();
    expect(row.querySelector('.cinder-timeline-item__header')).toBeNull();
    const entries: TimelineEntry[] = [
      { id: 'a', kind: 'run', datetime: '2026-11-02T09:00:00Z', timestamp: 'a', title: 'a' },
      { id: 'b', kind: 'run', datetime: '2026-11-01T09:00:00Z', timestamp: 'b', title: 'b' },
    ];
    const [group] = buildTimelineRenderPlan({ entries });
    expect(group?.entries.map((entry) => entry.connectorAfter)).toEqual(['hidden', 'hidden']);
  });

  test('a run has a hairline under it except the last row', () => {
    expect(css).toMatch(
      /\[data-cinder-kind='run'\]\s*\{[^}]*border-block-end: 1px solid var\(--cinder-border-faint\)/,
    );
    expect(css).toMatch(/\[data-cinder-kind='run'\]:last-child\s*\{\s*border-block-end: 0;/);
  });
});

describe('Timeline struck occurrence (row 73g)', () => {
  test('crosses the time out and leaves the relative title as it is', () => {
    const { container } = render(Fixture, {});
    const first = container.querySelector('li.cinder-timeline-item');
    const time = first?.querySelector('time');
    expect(time?.hasAttribute('data-cinder-struck')).toBe(true);
    expect(first?.querySelector('.cinder-timeline-item__title')?.textContent).toBe('in 16 hours');
    expect(css).toMatch(
      /\.cinder-timeline-item__time\[data-cinder-struck\]\s*\{\s*text-decoration: line-through;/,
    );
  });
});

describe('Timeline band disclosure (row 73l)', () => {
  test('starts closed and reports each change with whether it is now open', async () => {
    const changes: boolean[] = [];
    const { container } = render(Fixture, { onExpandedChange: (open) => changes.push(open) });
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle!);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(toggle!);
    expect(changes).toEqual([true, false]);
  });

  test('an entry that starts expanded is open, and says Hide', () => {
    const { container } = render(Fixture, { expanded: true });
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('.cinder-stacked-list-item__band-label')?.textContent?.trim(),
    ).toBe('Hide');
  });
});

describe('Timeline plain event (row 73m)', () => {
  test('draws no marker, and a warning tone colours the title in the list variant', () => {
    const { container } = render(Fixture, {});
    const row = container.querySelector<HTMLElement>('li[data-cinder-plain]');
    expect(row?.querySelector('time')?.textContent).toBe('Mon Nov 2, 3:00 AM');
    expect(row?.querySelector('.cinder-timeline-item__title')?.textContent).toBe(
      'Missed · Interborough was off',
    );
    expect(css).toMatch(
      /\[data-cinder-plain\] \.cinder-timeline-item__marker\s*\{\s*display: none;/,
    );
    expect(css).toMatch(
      /\[data-cinder-tone='warning'\]\[data-cinder-plain\]\s*\.cinder-timeline-item__title\s*\{\s*color: var\(--cinder-status-warning-text\)/,
    );
  });

  test('an event with no body leaves no gap for one', () => {
    expect(css).toMatch(/\.cinder-timeline-item__body:empty\s*\{\s*display: none;/);
  });
});
