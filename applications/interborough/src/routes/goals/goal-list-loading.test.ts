/**
 * `<GoalListLoading>`, the Goals list while its goals are being read (design rows 68k and 68l):
 * nothing for the first 300 ms, then the filter bar with its segments and no counts and three
 * placeholder rows in the real layout, each with a placeholder for the attempts bar, and after 10 s
 * Cinder's own "Still loading goals…" line with a Cancel. The timings run under fake timers, never
 * a sleep.
 */
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { flushSync } from 'svelte';

import { GOALS_COPY } from '../../app/copy.ts';
import GoalListLoading, {
  GOAL_LOADING_DELAY_MILLISECONDS,
  GOAL_STILL_LOADING_MILLISECONDS,
} from './goal-list-loading.svelte';
import { GOAL_SEGMENT_LABELS, GOAL_SEGMENTS } from './goal-rows.ts';

afterEach(() => {
  jest.useRealTimers();
  cleanup();
});

function mount(overrides: { segmentValue?: string; onCancel?: () => void } = {}) {
  const onCancel = overrides.onCancel ?? (() => {});
  return render(GoalListLoading, {
    props: {
      segments: GOAL_SEGMENTS.map((value) => ({ value, label: GOAL_SEGMENT_LABELS[value] })),
      segmentValue: overrides.segmentValue ?? 'all',
      facets: [
        {
          type: 'choice',
          key: 'agent',
          label: GOALS_COPY.agentLabel,
          multiple: false,
          options: [{ value: 'assistant', label: 'Assistant' }],
        },
      ],
      appliedFilters: [],
      onSegmentChange: () => {},
      onFacetChange: () => {},
      onFilterRemove: () => {},
      onCancel,
    },
  } as never);
}

function advance(milliseconds: number): void {
  jest.advanceTimersByTime(milliseconds);
  flushSync();
}

describe('a read in progress', () => {
  test('draws nothing for the first 300 ms, then the filter bar and three rows with a placeholder for the attempts bar', () => {
    jest.useFakeTimers();
    const { container } = mount();
    const view = within(container);

    expect(container.querySelector('[data-testid="goal-list-loading"]')).toBeNull();
    expect(view.queryByRole('radio')).toBeNull();

    advance(GOAL_LOADING_DELAY_MILLISECONDS - 1);
    expect(container.querySelector('[data-testid="goal-list-loading"]')).toBeNull();

    advance(1);
    expect(container.querySelectorAll('[data-testid="goal-loading-row"]')).toHaveLength(3);
    const bars = container.querySelectorAll('[data-testid="goal-loading-attempts"]');
    expect(bars).toHaveLength(3);
    expect(bars[0]?.children).toHaveLength(5);
    // The segments read as they will, each with a placeholder where its count will be, and the
    // Agent chip stays.
    for (const label of ['All', 'Running', 'Done', 'Gave up', 'Stopped']) {
      expect(
        view.getByRole('radio', { name: new RegExp(`^${label}\\s*,\\s*loading$`) }),
      ).not.toBeNull();
    }
    expect(view.getByRole('button', { name: /Agent/ })).not.toBeNull();
  });

  test('keeps the segment the address chose', () => {
    jest.useFakeTimers();
    const { container } = mount({ segmentValue: 'gave-up' });
    advance(GOAL_LOADING_DELAY_MILLISECONDS);
    expect(
      within(container)
        .getByRole('radio', { name: /^Gave up\s*,\s*loading$/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('says it is taking longer than usual at 10 s, and not before, with a Cancel that stops the read', async () => {
    jest.useFakeTimers();
    let cancelled = 0;
    const { container } = mount({
      onCancel: () => {
        cancelled += 1;
      },
    });
    advance(GOAL_STILL_LOADING_MILLISECONDS - 1);
    expect(container.textContent).not.toContain(GOALS_COPY.stillLoading);
    advance(1);
    expect(container.textContent).toContain(GOALS_COPY.stillLoading);

    await fireEvent.click(within(container).getByRole('button', { name: 'Cancel' }));
    expect(cancelled).toBe(1);
  });
});
