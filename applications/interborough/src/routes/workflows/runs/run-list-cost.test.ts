/**
 * The Cost column of `/runs` (COR-2525): each run's row says what it cost, a goal's attempt says its
 * own cost, an instance of a workflow file says the sum of its steps that have one (marked partial
 * when a step has none), and a run with no cost has no cost on its row, never `$0.00`.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { COST_COPY } from '../../../app/copy/cost.ts';
import {
  goalAttemptFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import RunListRow from './run-list-row.svelte';
import { buildRunRows, runListRows, type RunRow } from './run-rows.ts';

afterEach(cleanup);

const NOW = Date.parse('2026-11-02T10:50:00-06:00');

const usage = (costUsd: number | null): NonNullable<TaskView['usage']> => ({
  promptTokens: 10,
  completionTokens: 10,
  totalTokens: 20,
  costUsd,
});

function rowsOf(...tasks: TaskView[]): RunRow[] {
  return runListRows(buildRunRows({ tasks, goals: [], chats: [] }));
}

function cellOf(row: RunRow): string | undefined {
  const { container } = render(RunListRow, {
    props: { row, now: NOW, zone: 'America/Chicago', agentLabel: (name: string) => name },
  });
  return container.querySelector('[data-testid="run-cost"]')?.textContent ?? undefined;
}

describe('a run’s cost on its row', () => {
  test('is the run’s own figure, and nothing for a run with none', () => {
    const [priced, unpriced, unreported] = rowsOf(
      taskFixture({ id: 'run-a', status: 'completed', usage: usage(0.1234) }),
      taskFixture({ id: 'run-b', status: 'completed', usage: usage(null) }),
      taskFixture({ id: 'run-c', status: 'working', usage: null }),
    ).toSorted((left, right) => left.id.localeCompare(right.id));

    expect(priced?.cost).toEqual({ costUsd: 0.1234, partial: false });
    expect(unpriced?.cost).toBeNull();
    expect(unreported?.cost).toBeNull();
  });

  test('AC3: a goal’s attempt says its own cost, and a task’s own figure wins over the goal’s record', () => {
    const goal = goalFixture('goal-1', {
      attempts: [
        goalAttemptFixture('goal-1-a0', { usage: { steps: 1, tokens: 1, costUsd: 0.5 } }),
        goalAttemptFixture('goal-1-a1', { usage: { steps: 1, tokens: 1, costUsd: null } }),
      ],
    });
    const rows = runListRows(
      buildRunRows({
        tasks: [taskFixture({ id: 'goal-1-a0', status: 'completed', usage: usage(0.75) })],
        goals: [goal],
        chats: [],
      }),
    );

    const byId = new Map(rows.map((row) => [row.id, row] as const));
    expect(byId.get('goal-1-a0')?.cost).toEqual({ costUsd: 0.75, partial: false });
    expect(byId.get('goal-1-a1')?.cost).toBeNull();
  });
});

describe('the cost of an instance of a workflow file', () => {
  const step = (id: string, costUsd: number | null): TaskView =>
    taskFixture({
      id,
      kind: 'catalog',
      status: 'completed',
      origin: { kind: 'parent', parentRunId: 'instance-1' },
      usage: usage(costUsd),
    });

  test('AC3: is the sum of its steps that have a cost, partial when a step has none', () => {
    expect(rowsOf(step('s1', 0.25), step('s2', 0.5))[0]?.cost).toEqual({
      costUsd: 0.75,
      partial: false,
    });
    expect(rowsOf(step('s1', 0.25), step('s2', null))[0]?.cost).toEqual({
      costUsd: 0.25,
      partial: true,
    });
    expect(rowsOf(step('s1', null), step('s2', null))[0]?.cost).toBeNull();
  });

  // The engine's own row of the instance, as the normal `/runs` query lists it: it has no usage.
  const engineRow = () =>
    taskFixture({
      id: 'instance-1',
      kind: 'catalog',
      agentName: null,
      status: 'completed',
      origin: { kind: 'api' },
      usage: null,
    });

  test('AC3: an engine row with no usage of its own is the sum of its steps, partial when a step has none', () => {
    const priced = rowsOf(engineRow(), step('s1', 0.75));
    expect(priced).toHaveLength(1);
    expect(priced[0]?.id).toBe('instance-1');
    expect(priced[0]?.cost).toEqual({ costUsd: 0.75, partial: false });

    expect(rowsOf(engineRow(), step('s1', 0.75), step('s2', null))[0]?.cost).toEqual({
      costUsd: 0.75,
      partial: true,
    });
    expect(rowsOf(engineRow(), step('s1', null))[0]?.cost).toBeNull();
  });
});

describe('the Cost column of a row', () => {
  test('AC4: shows a cost as an amount, and shows no cell for a run with none', () => {
    const [priced, unpriced] = rowsOf(
      taskFixture({ id: 'run-a', status: 'completed', usage: usage(0.1234) }),
      taskFixture({ id: 'run-b', status: 'completed', usage: usage(null) }),
    ).toSorted((left, right) => left.id.localeCompare(right.id));
    if (priced === undefined || unpriced === undefined) throw new Error('No rows were made.');

    expect(cellOf(priced)).toBe('$0.12');
    cleanup();
    expect(cellOf(unpriced)).toBeUndefined();
  });

  test('AC5: says an amount under one cent as `< $0.01`', () => {
    const [row] = rowsOf(taskFixture({ id: 'run-a', status: 'completed', usage: usage(0.002) }));
    if (row === undefined) throw new Error('No row was made.');

    expect(cellOf(row)).toBe(COST_COPY.underOneCent);
  });

  test('says a partial sum as "At least" the sum, and carries why in its tooltip', () => {
    const [row] = rowsOf(taskFixture({ id: 'run-a', status: 'completed', usage: usage(0.4) }));
    if (row === undefined) throw new Error('No row was made.');
    const partial: RunRow = { ...row, cost: { costUsd: 0.4, partial: true } };

    const { container } = render(RunListRow, {
      props: {
        row: partial,
        now: NOW,
        zone: 'America/Chicago',
        agentLabel: (name: string) => name,
      },
    });
    const cell = container.querySelector('[data-testid="run-cost"]');
    expect(cell?.textContent).toBe(COST_COPY.atLeast('$0.40'));
    expect(cell?.getAttribute('title')).toBe(COST_COPY.partialNote);
  });
});
