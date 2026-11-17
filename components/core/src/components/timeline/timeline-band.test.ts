/// <reference lib="dom" />
/**
 * COR-2010 (B02, row 72i): below Now, the missed runs show once as a single collapsed amber band
 * (dot, chevron, title, muted detail and a "Show each" toggle), and no connector or marker is drawn
 * for it.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { buildTimelineRenderPlan } from './timeline-groups.ts';
import type { TimelineEntry } from './timeline.types.ts';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/timeline-band-fixture.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function band(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    'li.cinder-timeline-item[data-cinder-kind="band"]',
  );
  if (row === null) throw new Error('no band row');
  return row;
}

describe('Timeline band entry', () => {
  test('is one collapsed amber group row with the title, the detail and the toggle label', () => {
    const { container } = render(Fixture, {});
    const row = band(container);
    const group = row.querySelector('.cinder-stacked-list-item--band');
    expect(group?.classList.contains('cinder-stacked-list-item--tone-warning')).toBe(true);
    expect(row.querySelector('.cinder-stacked-list-item__band-title')?.textContent).toBe(
      'Missed 4 times since Oct 30',
    );
    expect(row.querySelector('.cinder-stacked-list-item__band-meta')?.textContent).toBe(
      'Interborough was off',
    );
    expect(row.querySelector('.cinder-stacked-list-item__band-label')?.textContent?.trim()).toBe(
      'Show each',
    );
    expect(row.querySelector('[data-cinder-status="warning"]')).not.toBeNull();
    expect(row.querySelector('.cinder-timeline-item__marker')).toBeNull();
    expect(row.querySelector('.cinder-timeline-item__actions')).toBeNull();
  });

  test('the toggle opens the entry body and says Hide', async () => {
    const { container } = render(Fixture, {});
    const row = band(container);
    const toggle = row.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    const details = row.querySelector<HTMLElement>('.cinder-stacked-list-item__details');
    expect(details?.hasAttribute('hidden')).toBe(true);
    await fireEvent.click(toggle!);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(details?.hasAttribute('hidden')).toBe(false);
    expect(details?.querySelector('[data-testid="missed-detail"]')).not.toBeNull();
    expect(row.querySelector('.cinder-stacked-list-item__band-label')?.textContent?.trim()).toBe(
      'Hide',
    );
  });

  test('a non-warning tone draws a neutral band', () => {
    const { container } = render(Fixture, { tone: 'info' });
    expect(
      band(container)
        .querySelector('.cinder-stacked-list-item--band')
        ?.classList.contains('cinder-stacked-list-item--tone-neutral'),
    ).toBe(true);
  });

  test('is a list item of the ordered list, in source order after Now', () => {
    const { container } = render(Fixture, {});
    const kinds = Array.from(container.querySelectorAll('ol.cinder-timeline > li')).map((row) =>
      row.getAttribute('data-cinder-kind'),
    );
    expect(kinds).toEqual(['now', 'band', 'event']);
  });

  test('no connector runs into or out of a band', () => {
    const entries: TimelineEntry[] = [
      { id: 'a', datetime: '2026-11-03T09:00:00Z', timestamp: 'a', title: 'a' },
      { id: 'b', kind: 'band', datetime: '2026-11-02T09:00:00Z', timestamp: 'b', title: 'b' },
      { id: 'c', datetime: '2026-11-01T09:00:00Z', timestamp: 'c', title: 'c' },
      { id: 'd', datetime: '2026-10-31T09:00:00Z', timestamp: 'd', title: 'd' },
    ];
    const [group] = buildTimelineRenderPlan({ entries });
    expect(
      Object.fromEntries((group?.entries ?? []).map((e) => [e.entry.id, e.connectorAfter])),
    ).toEqual({ a: 'hidden', b: 'hidden', c: 'visible', d: 'hidden' });
  });
});
