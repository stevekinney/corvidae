import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { ATTEMPT_HISTORY_PAGE_SIZE } from './task-attempt-evidence.ts';
import TaskAttemptHistory from './task-attempt-history.svelte';
import type { TaskAttemptRecord, TaskLedgerDetail } from './worker-catalog-types.ts';

const NOW = 1_700_000_000_000;
const ATTEMPT_COUNT = 1_000;

function attempts(count: number): TaskAttemptRecord[] {
  // Deliberately unordered, as the ledger may return it, so ordering is the view's job.
  return Array.from({ length: count }, (_, index) => {
    const attempt = count - index;
    const claimedAt = NOW - (count - attempt + 1) * 10_000;
    return {
      attempt,
      attemptTokenDigest: `sha256:token-${attempt}`,
      claimedAt,
      disposition: attempt === count ? 'leased' : 'requeued',
      // Each disposition lands after the next attempt's claim, so every
      // superseded window is fenced at that claim.
      dispositionAt: claimedAt + 15_000,
    };
  });
}

function task(count: number): TaskLedgerDetail {
  return {
    state: 'leased',
    operationId: 'op_long_lived',
    workflowType: 'orders',
    activityName: 'charge',
    queue: 'payments',
    headerKeys: [],
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: NOW - 100_000_000,
    attempt: count,
    attempts: attempts(count),
  };
}

function renderedAttempts(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-attempt]'), (element) =>
    Number(element.dataset['attempt']),
  );
}

describe('TaskAttemptHistory — large histories', () => {
  test('mounts only the newest page of a long history, oldest first, ending at the current attempt', () => {
    const { container, getByText } = render(TaskAttemptHistory, {
      props: { task: task(ATTEMPT_COUNT) },
    });

    const shown = renderedAttempts(container);
    expect(shown).toHaveLength(ATTEMPT_HISTORY_PAGE_SIZE);
    expect(shown[0]).toBe(ATTEMPT_COUNT - ATTEMPT_HISTORY_PAGE_SIZE + 1);
    expect(shown.at(-1)).toBe(ATTEMPT_COUNT);
    expect(shown).toEqual(shown.toSorted((left, right) => left - right));
    expect(getByText(`Attempt ${ATTEMPT_COUNT} · current`)).not.toBeNull();
    expect(
      getByText(`Showing the newest ${ATTEMPT_HISTORY_PAGE_SIZE} of ${ATTEMPT_COUNT} attempts.`),
    ).not.toBeNull();
  });

  test('fences the oldest shown attempt against its successor, not against the window edge', () => {
    const { container } = render(TaskAttemptHistory, { props: { task: task(ATTEMPT_COUNT) } });
    const oldestShown = ATTEMPT_COUNT - ATTEMPT_HISTORY_PAGE_SIZE + 1;
    const entry = container.querySelector<HTMLElement>(`[data-attempt="${oldestShown}"]`);
    if (!entry) throw new Error('missing oldest shown attempt');

    expect(within(entry).getByText('Superseded')).not.toBeNull();
    expect(
      within(entry).getByText(
        `Attempt ${oldestShown + 1} at ${new Date(NOW - (ATTEMPT_COUNT - oldestShown) * 10_000).toISOString()}`,
      ),
    ).not.toBeNull();
    expect(within(entry).getByText(/fenced and does not extend this window$/)).not.toBeNull();
  });

  test('loads older attempts a page at a time until the whole history is shown', async () => {
    const count = ATTEMPT_HISTORY_PAGE_SIZE * 2 + 5;
    const { container, getByRole, queryByRole } = render(TaskAttemptHistory, {
      props: { task: task(count) },
    });

    await fireEvent.click(
      getByRole('button', { name: `Show ${ATTEMPT_HISTORY_PAGE_SIZE} older attempts` }),
    );
    expect(renderedAttempts(container)).toHaveLength(ATTEMPT_HISTORY_PAGE_SIZE * 2);

    await fireEvent.click(getByRole('button', { name: 'Show 5 older attempts' }));
    const shown = renderedAttempts(container);
    expect(shown).toHaveLength(count);
    expect(shown[0]).toBe(1);
    expect(queryByRole('button', { name: /older attempts/ })).toBeNull();
  });

  test('a short history shows every attempt with no paging control', () => {
    const { container, queryByRole, queryByText } = render(TaskAttemptHistory, {
      props: { task: task(3) },
    });
    expect(renderedAttempts(container)).toEqual([1, 2, 3]);
    expect(queryByRole('button', { name: /older attempts/ })).toBeNull();
    expect(queryByText(/Showing the newest/)).toBeNull();
  });
});
