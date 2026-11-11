/**
 * A goal's page in the states that are not a goal on screen with a live server (board PageGoals,
 * "Goal page, loading" and "Goal page, offline with data", rows 68t and 68w): a read in progress, a
 * read the person gave up on, and a goal shown while Interborough does not answer. The page keeps
 * its header in each; while the goal is read the heading is "Goal" and the Attempts heading is real.
 * The timings the placeholders keep run under fake timers, never a sleep.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { flushSync } from 'svelte';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { GOALS_COPY, RETRY_LABEL } from '../../app/copy.ts';
import { goalAttemptFixture, goalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../../lib/bureau-goals.ts';
import { installBureauStub, type BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import GoalDetail from './goal-detail.svelte';

const copy = GOALS_COPY.detail;

let restore: (() => void) | undefined;
let stub: BureauStub | undefined;
let connection: ConnectionMonitor | undefined;
afterEach(() => {
  jest.useRealTimers();
  cleanup();
  restore?.();
  restore = undefined;
  stub?.restore();
  stub = undefined;
  connection?.dispose();
  connection = undefined;
});

const PRINCIPAL = { scopes: [], subject: 'anonymous:local', unauthenticatedAccess: null };

function advance(milliseconds: number): void {
  jest.advanceTimersByTime(milliseconds);
  flushSync();
}

describe('a goal’s page while the goal is read (row 68t)', () => {
  function openHanging() {
    restore = installFetchImplementation(() => new Promise<Response>(() => {}));
    landAt('/goals/goal-1');
    const rendered = render(QueryPage, {
      props: { page: GoalDetail, principal: PRINCIPAL },
    } as never);
    flushSync();
    return rendered;
  }

  test('says "Goal" and keeps the Attempts heading at once, with placeholders only after 300 ms', () => {
    jest.useFakeTimers();
    const { container } = openHanging();
    const view = within(container);

    expect(view.getByRole('heading', { level: 1, name: copy.loadingTitle })).not.toBeNull();
    expect(view.getByRole('heading', { level: 2, name: copy.attemptsHeading })).not.toBeNull();
    expect(container.querySelector('.cinder-skeleton-row')).toBeNull();

    advance(299);
    expect(container.querySelector('.cinder-skeleton-row')).toBeNull();
    advance(1);
    expect(container.querySelectorAll('.cinder-skeleton-row').length).toBeGreaterThan(0);
    // Edit and Stop goal wait for the goal.
    expect(view.queryByRole('link', { name: copy.editAction })).toBeNull();
    expect(view.queryByRole('button', { name: copy.stopAction })).toBeNull();
  });

  test('says it is still loading this goal at 10 s, and not before', () => {
    jest.useFakeTimers();
    const { container } = openHanging();

    advance(9_999);
    expect(container.textContent).not.toContain(copy.stillLoading);
    advance(1);
    expect(container.textContent).toContain(copy.stillLoading);
  });

  test('stops the read on Cancel and says so, with Try again, under the same heading', async () => {
    jest.useFakeTimers();
    const { container } = openHanging();
    advance(10_000);

    await fireEvent.click(within(container).getByRole('button', { name: 'Cancel' }));
    flushSync();

    const view = within(container);
    expect(view.getByRole('heading', { level: 1, name: copy.loadingTitle })).not.toBeNull();
    expect(view.getByRole('heading', { level: 2, name: copy.stopped.title })).not.toBeNull();
    expect(view.getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    expect(container.querySelector('.cinder-skeleton-row')).toBeNull();
  });
});

describe('a goal’s page while Interborough does not answer (row 68w)', () => {
  function openWith(goal: Goal) {
    stub = installBureauStub({
      'bureau.goals.get': () => goal,
      'bureau.agents.list': () => ({ agents: [] }),
    });
    connection = new ConnectionMonitor({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
      probeDelayMs: () => 60_000,
      browserOffline: false,
    });
    landAt(`/goals/${goal.goalRunId}`);
    return render(QueryPage, {
      props: { page: GoalDetail, principal: PRINCIPAL, connection },
    } as never);
  }

  const working = goalFixture('goal-1', {
    identity: { name: 'Summarize open refunds', version: '1' },
    status: 'evaluating',
    bounds: { ...goalFixture('x').bounds, maximumAttempts: 5 },
    usage: { attempts: 2, steps: 2, tokens: 2, costUsd: null, durationMs: 1 },
    attempts: [
      goalAttemptFixture('run-1', { attemptIndex: 0, status: 'failed' }),
      goalAttemptFixture('run-2', { attemptIndex: 1, status: 'evaluating' }),
    ],
  });

  test('turns only Edit and Stop goal off, says why beside them, and keeps the goal on screen', async () => {
    const { container, findByRole } = openWith(working);
    await findByRole('heading', { level: 1, name: 'Summarize open refunds' });
    const view = within(container);
    expect(view.queryByTestId('goal-offline-reason')).toBeNull();

    connection?.reportUnreachable();

    const reason = await view.findByTestId('goal-offline-reason');
    expect(reason.textContent?.trim()).toBe(copy.offlineReason);
    const edit = view.getByText(copy.editAction).closest('a');
    const stop = view.getByText(copy.stopAction).closest('button');
    expect(edit?.getAttribute('aria-disabled')).toBe('true');
    expect(stop?.getAttribute('aria-disabled')).toBe('true');
    expect(edit?.getAttribute('aria-describedby')).toContain(reason.id);
    expect(stop?.getAttribute('aria-describedby')).toContain(reason.id);
    // The attempts stay as they were read.
    expect(container.querySelectorAll('[data-attempt]').length).toBe(2);
    expect(view.getByTestId('goal-attempts-heading').textContent).toContain('2 of 5');
  });

  test('leaves Start again live, since it only opens New goal', async () => {
    const stopped = goalFixture('goal-2', {
      identity: { name: 'Summarize open refunds', version: '1' },
      status: 'canceled',
      closedAt: '2026-10-30T15:08:12.000Z',
    });
    const { container, findByRole } = openWith(stopped);
    await findByRole('heading', { level: 1, name: 'Summarize open refunds' });

    connection?.reportUnreachable();

    const view = within(container);
    await view.findByTestId('goal-offline-reason');
    const again = view.getByText(copy.startAgainAction).closest('a');
    expect(again?.getAttribute('aria-disabled')).toBeNull();
    await waitFor(() =>
      expect(view.getByText(copy.editAction).closest('a')?.getAttribute('aria-disabled')).toBe(
        'true',
      ),
    );
  });
});
