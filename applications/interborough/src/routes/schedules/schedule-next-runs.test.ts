/**
 * The next runs follow the schedule the page is given: when a fire moves `nextFireAt`, the list is
 * recounted from it, and the Skip button never offers a time that has already passed.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import ScheduleNextRuns from './schedule-next-runs.svelte';
import type { ScheduleTiming } from './schedule-time.ts';

const DAY = 86_400_000;
const NINE = Date.UTC(2026, 10, 3, 9, 0);

const nightly = (overrides: Partial<ScheduleTiming> = {}): ScheduleTiming => ({
  status: 'active',
  cronExpression: '0 9 * * *',
  timeZone: 'UTC',
  nextFireAt: NINE,
  ...overrides,
});

function listed(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('time'), (time) => time.getAttribute('datetime')!);
}

describe('the next runs list', () => {
  test('is counted again when the schedule it is given changes after a fire', async () => {
    const view = render(ScheduleNextRuns, {
      props: { schedule: nightly(), canSkip: true, busy: false, onSkip: () => {} },
    });
    expect(listed(view.container)[0]).toBe(new Date(NINE).toISOString());

    // The 09:00 run fired; the schedule now reports the next one. No `now` is passed, so a clock
    // frozen when the page mounted would have kept offering the first.
    await view.rerender({
      schedule: nightly({ nextFireAt: NINE + DAY, lastFireAt: NINE }),
    });
    expect(listed(view.container)[0]).toBe(new Date(NINE + DAY).toISOString());
    expect(listed(view.container)).not.toContain(new Date(NINE).toISOString());
  });

  test('marks a skipped run only while the schedule still lists it', async () => {
    const view = render(ScheduleNextRuns, {
      props: {
        schedule: nightly({ skipUntil: NINE }),
        canSkip: true,
        busy: false,
        onSkip: () => {},
      },
    });
    expect(view.container.querySelectorAll('[data-skipped="true"]')).toHaveLength(1);

    // The skipped run has passed: the engine moved on, so nothing in the list is marked.
    await view.rerender({
      schedule: nightly({ nextFireAt: NINE + DAY, lastFireAt: NINE, skipUntil: NINE }),
    });
    expect(view.container.querySelectorAll('[data-skipped="true"]')).toHaveLength(0);
  });

  test('offers Skip on the run the schedule reports, even when its time is already past', async () => {
    let skipped = 0;
    const view = render(ScheduleNextRuns, {
      props: {
        // A due run waiting out its jitter: `nextFireAt` is behind the page's clock.
        schedule: nightly({ nextFireAt: Date.now() - 60_000 }),
        canSkip: true,
        busy: false,
        onSkip: () => (skipped += 1),
      },
    });
    const first = view.container.querySelector('li');
    expect(first?.getAttribute('data-next')).toBe('true');
    await fireEvent.click(view.getByRole('button', { name: 'Skip the next one' }));
    expect(skipped).toBe(1);
  });
});
