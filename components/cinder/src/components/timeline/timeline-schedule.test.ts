/// <reference lib="dom" />
/**
 * COR-2010 (B02, rows 72h and 72j): the Schedule detail "Runs" list. Upcoming occurrences carry a
 * hollow pending ring and a Skip action, an accent "Now" marker splits them from the past, and a
 * quiet labelled separator marks where daylight saving time ended.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import { buildTimelineRenderPlan } from './timeline-groups.ts';
import type { TimelineEntry } from './timeline.types.ts';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/timeline-schedule-fixture.svelte');

const css = readFileSync(new URL('./timeline.css', import.meta.url), 'utf8');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function items(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('li.cinder-timeline-item'));
}

describe('Timeline pending tone and actions (row 72h)', () => {
  test('upcoming rows carry the pending tone and one Skip action each', () => {
    const { container } = render(Fixture, {});
    const rows = items(container);
    for (const row of rows.slice(0, 3)) {
      expect(row.getAttribute('data-cinder-tone')).toBe('pending');
      expect(row.getAttribute('data-cinder-kind')).toBe('event');
      expect(row.querySelectorAll('.cinder-timeline-item__actions button')).toHaveLength(1);
      expect(row.querySelector('.cinder-timeline-item__actions')?.textContent?.trim()).toBe('Skip');
    }
  });

  test('actions are interactive: they are not inside the inert, aria-hidden marker', () => {
    const { container } = render(Fixture, {});
    const skip = container.querySelector('[data-testid="skip-nov-5"]');
    expect(skip).not.toBeNull();
    expect(skip?.closest('[aria-hidden="true"]')).toBeNull();
    expect(skip?.closest('[inert]')).toBeNull();
  });

  test('rows render in source order, furthest first and nearest to Now last', () => {
    const { container } = render(Fixture, {});
    const stamps = items(container)
      .slice(0, 3)
      .map((row) => row.querySelector('time')?.textContent);
    expect(stamps).toEqual(['Thu Nov 5, 3:00 AM', 'Wed Nov 4, 3:00 AM', 'Tue Nov 3, 3:00 AM']);
  });

  test('an event row marks has-actions so the grid reserves the action column', () => {
    const { container } = render(Fixture, {});
    expect(
      container
        .querySelector('li.cinder-timeline-item')
        ?.querySelector('.cinder-timeline-item__event')
        ?.hasAttribute('data-cinder-has-actions'),
    ).toBe(true);
  });

  test('the list variant is set on the list and has no connector rule', () => {
    const { container } = render(Fixture, {});
    expect(container.querySelector('ol.cinder-timeline')?.getAttribute('data-cinder-variant')).toBe(
      'list',
    );
    expect(css).toMatch(
      /\[data-cinder-variant='list'\] \.cinder-timeline-item__event::before\s*\{\s*display: none;/,
    );
  });

  test('the rail variant keeps the connector rule and the Now and separator rows', () => {
    const { container } = render(Fixture, { variant: 'rail' });
    expect(container.querySelector('ol.cinder-timeline')?.getAttribute('data-cinder-variant')).toBe(
      'rail',
    );
    expect(items(container).map((row) => row.getAttribute('data-cinder-kind'))).toEqual([
      'event',
      'event',
      'event',
      'now',
      'separator',
      'event',
    ]);
    expect(css).toMatch(/\.cinder-timeline-item__event::before\s*\{\s*content: '';/);
  });

  test('pending draws a hollow ring in the contrast border colour', () => {
    const rule = /data-cinder-tone='pending'\] \.cinder-timeline-item__marker\s*\{([^}]*)\}/.exec(
      css,
    )?.[1];
    expect(rule).toContain('border-color: var(--cinder-border-contrast)');
    expect(rule).toContain('background: transparent');
  });
});

describe('Timeline Now marker (row 72h)', () => {
  test('draws an accent pill, a rule and the time, with no marker, body or actions', () => {
    const { container } = render(Fixture, {});
    const now = items(container)[3];
    expect(now?.getAttribute('data-cinder-kind')).toBe('now');
    expect(now?.querySelector('.cinder-timeline-item__now-label')?.textContent).toBe('Now');
    expect(now?.querySelector('time')?.textContent).toBe('Mon Nov 2, 10:46 AM');
    expect(now?.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-02T16:46:00Z');
    expect(now?.querySelector('.cinder-timeline-item__rule')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(now?.querySelector('.cinder-timeline-item__marker')).toBeNull();
    expect(now?.querySelector('.cinder-timeline-item__actions')).toBeNull();
    expect(now?.querySelector('[data-testid="body-now"]')).toBeNull();
  });

  test('the pill is the accent fill and the rule is the accent', () => {
    const pill = /\.cinder-timeline-item__now-label\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(pill).toContain('background: var(--cinder-accent-solid)');
    expect(pill).toContain('color: var(--cinder-accent-contrast)');
    const rule = /\.cinder-timeline-item__now \.cinder-timeline-item__rule\s*\{([^}]*)\}/.exec(
      css,
    )?.[1];
    expect(rule).toContain('background: var(--cinder-accent-solid)');
  });
});

describe('Timeline separator (row 72j)', () => {
  test('draws the label between two decorative rules, with no marker, body or actions', () => {
    const { container } = render(Fixture, {});
    const separator = items(container)[4];
    expect(separator?.getAttribute('data-cinder-kind')).toBe('separator');
    expect(separator?.querySelector('.cinder-timeline-item__separator-label')?.textContent).toBe(
      'Daylight saving time ended Nov 1',
    );
    const rules = separator?.querySelectorAll('.cinder-timeline-item__rule') ?? [];
    expect(rules).toHaveLength(2);
    for (const rule of Array.from(rules)) expect(rule.getAttribute('aria-hidden')).toBe('true');
    expect(separator?.querySelector('.cinder-timeline-item__marker')).toBeNull();
    expect(separator?.querySelector('.cinder-timeline-item__actions')).toBeNull();
  });

  test('is still a list item of the ordered list, so list semantics hold', () => {
    const { container } = render(Fixture, {});
    expect(items(container)[4]?.tagName).toBe('LI');
    expect(items(container)[4]?.parentElement?.tagName).toBe('OL');
    expect(items(container)).toHaveLength(6);
  });
});

describe('Timeline connectors around Now and separator', () => {
  const entries: TimelineEntry[] = [
    { id: 'a', datetime: '2026-11-03T09:00:00Z', timestamp: 'a', title: 'a' },
    { id: 'b', datetime: '2026-11-03T08:00:00Z', timestamp: 'b', title: 'b' },
    { id: 'now', kind: 'now', datetime: '2026-11-02T16:46:00Z', timestamp: 'now', title: 'Now' },
    { id: 'c', datetime: '2026-11-02T10:00:00Z', timestamp: 'c', title: 'c' },
    { id: 'sep', kind: 'separator', datetime: '2026-11-01T06:00:00Z', timestamp: 's', title: 's' },
    { id: 'd', datetime: '2026-10-29T09:00:00Z', timestamp: 'd', title: 'd' },
    { id: 'e', datetime: '2026-10-28T09:00:00Z', timestamp: 'e', title: 'e' },
  ];

  test('no connector runs into or out of a now or separator entry, and ordinary rows still connect', () => {
    const [group] = buildTimelineRenderPlan({ entries });
    const connectors = Object.fromEntries(
      (group?.entries ?? []).map((entry) => [entry.entry.id, entry.connectorAfter]),
    );
    expect(connectors).toEqual({
      a: 'visible',
      b: 'hidden', // next is Now
      now: 'hidden',
      c: 'hidden', // next is the separator
      sep: 'hidden',
      d: 'visible',
      e: 'hidden', // last
    });
  });
});
