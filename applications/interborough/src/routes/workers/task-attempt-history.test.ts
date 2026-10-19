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

const IDENTITY = {
  workerId: 'worker-a',
  manifestDigest: 'sha256:manifest',
  sdkVersion: '1.0.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.0',
  deploymentName: 'payments',
  buildId: 'build-1',
  artifactDigest: 'sha256:artifact-1',
  workflowType: 'orders',
  workflowRevision: 'rev-7',
  activityName: 'charge',
  activityContractHash: 'sha256:contract-1',
  protocolVersion: 1,
} as const;

function crossBuildTask(state: TaskLedgerDetail['state'], last: TaskAttemptRecord['disposition']) {
  const base = task(2);
  return {
    ...base,
    state,
    attempts: [
      {
        attempt: 1,
        attemptTokenDigest: 'sha256:token-1',
        claimedAt: NOW - 60_000,
        disposition: 'requeued',
        dispositionAt: NOW - 50_000,
        executionIdentity: IDENTITY,
        executionRequirement: { deploymentName: 'payments', buildId: 'build-1' },
      },
      {
        attempt: 2,
        attemptTokenDigest: 'sha256:token-2',
        claimedAt: NOW - 40_000,
        disposition: last,
        dispositionAt: NOW - 30_000,
        executionIdentity: {
          ...IDENTITY,
          workerId: 'worker-b',
          buildId: 'build-2',
          artifactDigest: 'sha256:artifact-2',
        },
        executionRequirement: { deploymentName: 'payments' },
      },
    ],
  } satisfies TaskLedgerDetail;
}

describe('TaskAttemptHistory — worker provenance', () => {
  test.each([
    ['terminal', 'resolved'],
    ['deadLettered', 'deadLettered'],
    ['leased', 'leased'],
  ] as const)(
    'a %s task shows the routing requirement apart from the worker that ran each attempt',
    (state, last) => {
      const { container } = render(TaskAttemptHistory, {
        props: { task: crossBuildTask(state, last) },
      });
      const second = container.querySelector<HTMLElement>('[data-attempt="2"]');
      if (!second) throw new Error('missing attempt 2');
      expect(within(second).getByText('Routing requirement')).not.toBeNull();
      expect(within(second).getByText('deploymentName: payments')).not.toBeNull();
      expect(within(second).getByText('worker-b')).not.toBeNull();
      expect(within(second).getByText('build-2')).not.toBeNull();
      expect(within(second).getByText('sha256:contract-1')).not.toBeNull();
    },
  );

  test('flags a cross-build retry in text, naming the changed fields', () => {
    const { container } = render(TaskAttemptHistory, {
      props: { task: crossBuildTask('terminal', 'resolved') },
    });
    const first = container.querySelector<HTMLElement>('[data-attempt="1"]');
    const second = container.querySelector<HTMLElement>('[data-attempt="2"]');
    if (!first || !second) throw new Error('missing attempts');
    expect(within(first).queryByText('Crossed build')).toBeNull();
    expect(within(second).getByText('Crossed build')).not.toBeNull();
    expect(
      within(second).getByText(
        'Ran on a different worker artifact than attempt 1: build build-1 → build-2; artifact digest sha256:artifact-1 → sha256:artifact-2.',
      ),
    ).not.toBeNull();
  });

  test('says no constraint was recorded when an attempt has no routing requirement', () => {
    const { getAllByText } = render(TaskAttemptHistory, { props: { task: task(2) } });
    expect(getAllByText('No constraint recorded')).toHaveLength(2);
  });
});
