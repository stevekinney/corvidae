/**
 * `<GoalListRow>`, one goal as a row of the Goals list (design rows 10t, 04m and 06a): the agent,
 * the attempts bar with its count and the check on line two, and on a phone the check on a third
 * line of its own, so line two holds the agent and the attempts alone.
 */
import { cleanup, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { goalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import GoalListRow from './goal-list-row.svelte';
import { goalRow } from './goal-rows.ts';

afterEach(cleanup);

const ROW = goalRow(
  goalFixture('goal-1', {
    identity: { name: 'Summarize open refunds', version: '1' },
    validator: { name: 'summary-lists-every-refund-waiting-for-approval', version: '1' },
    agentName: 'tool-runner',
    status: 'canceled',
    createdAt: '2026-10-30T15:05:00.000Z',
    bounds: {
      maximumAttempts: 5,
      maximumTotalDurationMs: null,
      maximumTotalSteps: null,
      maximumTotalTokens: null,
      maximumTotalCostUsd: null,
    },
    usage: { attempts: 2, steps: 0, tokens: 0, costUsd: null, durationMs: 0 },
  }),
);

const CHECK = 'Check: Summary lists every refund waiting for approval';

function mount(phone: boolean) {
  return render(GoalListRow, {
    props: { row: ROW, agent: 'Tool runner', zone: 'America/Chicago', phone },
  } as never);
}

describe('a goal’s row', () => {
  test('says the agent, the attempts bar with its count and the check on line two', () => {
    const { container } = mount(false);
    const lineTwo = container.querySelector('.cinder-stacked-list-item__meta');
    expect(lineTwo?.textContent).toContain('Tool runner');
    expect(lineTwo?.textContent).toContain('2 of 5');
    expect(lineTwo?.textContent).toContain(CHECK);
    expect(
      within(lineTwo as HTMLElement).getByRole('img', { name: '2 of 5 attempts' }),
    ).not.toBeNull();
    // Nothing is on a third line.
    expect(container.querySelector('.cinder-stacked-list-item__detail')).toBeNull();
  });

  test('is titled by the goal’s name, which links to its page, with the time it began', () => {
    const { container, getByRole } = mount(false);
    expect(getByRole('link', { name: 'Summarize open refunds' }).getAttribute('href')).toBe(
      '/goals/goal-1',
    );
    // 10:05 AM in Chicago on Oct 30, on a twelve-hour clock.
    expect(container.querySelector('time')?.textContent).toBe('10:05 AM');
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-30T15:05:00.000Z',
    );
  });

  test('keeps the goal’s id, status and status word for a spec to match', () => {
    const { container } = mount(false);
    const item = container.querySelector('[data-goal]');
    expect(item?.getAttribute('data-goal')).toBe('goal-1');
    expect(item?.getAttribute('data-status')).toBe('canceled');
    expect(item?.getAttribute('data-status-word')).toBe('Stopped');
  });

  test('moves the check to a third line of its own on a phone, so line two is the agent and the attempts', () => {
    const { container } = mount(true);
    const lineTwo = container.querySelector('.cinder-stacked-list-item__meta');
    expect(lineTwo?.textContent).toContain('Tool runner');
    expect(lineTwo?.textContent).toContain('2 of 5');
    expect(lineTwo?.textContent).not.toContain('Check:');
    const third = container.querySelector('.cinder-stacked-list-item__detail');
    expect(third?.textContent).toContain(CHECK);
  });
});
