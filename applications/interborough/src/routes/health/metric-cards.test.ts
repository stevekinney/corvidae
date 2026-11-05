/**
 * The three metric cards (`metric-cards.svelte`) in the all-clear state (row 76v) and while the
 * page loads (row 76x): the figures a quiet day reads, and the placeholders that stand in for them.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { startedCaption, startedSummary } from './health-overview-data.ts';
import MetricCards from './metric-cards.svelte';

afterEach(cleanup);

const GIGABYTE = 1_073_741_824;
const DAY = 24 * 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 16, 46);

describe('the metric cards on a quiet day', () => {
  test('read 0.4 GB with a flat line, 14 runs against 11 the day before, and a median finish of 1m 12s', () => {
    const runs = Array.from({ length: 14 }, (_, index) => ({
      id: `run-${index}`,
      status: 'completed',
      createdAt: NOW - index * 60_000,
      updatedAt: NOW - index * 60_000 + 72_000,
    }));
    const view = render(MetricCards, {
      props: {
        storageBytes: 0.4 * GIGABYTE,
        samples: [
          { at: NOW - DAY, bytes: 0.4 * GIGABYTE },
          { at: NOW, bytes: 0.4 * GIGABYTE },
        ],
        started: startedSummary(runs, new Map(), 11),
        finish: { milliseconds: 72_000, count: 14 },
      },
    });

    const storage = view.container.querySelector('[data-metric="storage"]');
    expect(storage?.textContent).toContain('0.4 GB');
    expect(storage?.querySelector('.cinder-sparkbar')).not.toBeNull();
    expect(storage?.textContent).toContain('0.4 GB · 24 hours ago');
    expect(storage?.textContent).toContain('Now');
    const started = view.container.querySelector('[data-metric="runs-started"]');
    expect(started?.textContent).toContain('14');
    expect(started?.textContent).toContain(startedCaption(startedSummary(runs, new Map(), 11)));
    expect(started?.textContent).toContain('3 more than the day before');
    const finish = view.container.querySelector('[data-metric="time-to-finish"]');
    expect(finish?.textContent).toContain('1m 12s');
    expect(finish?.textContent).toContain('Median across 14 finished runs');
  });
});

describe('the metric cards while the page loads', () => {
  test('keep their headings and show the same bars in every card, even when a figure is known', () => {
    const view = render(MetricCards, {
      props: {
        storageBytes: GIGABYTE,
        samples: [],
        started: startedSummary([], new Map()),
        finish: 'none',
        loading: true,
      },
    });
    expect(
      [...view.container.querySelectorAll('h2')].map((heading) => heading.textContent),
    ).toEqual(['Storage use', 'Runs started', 'Time to finish']);
    for (const card of view.container.querySelectorAll('[data-metric]')) {
      expect(card.querySelectorAll('.cinder-skeleton')).toHaveLength(2);
      expect(card.textContent).not.toMatch(/GB|—|No run/);
    }
  });
});
