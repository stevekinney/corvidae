/**
 * What the Runs list reads of a task's attention states (COR-2528): a row carries the states in
 * the order a badge says them, the Needs attention filter is kept in the address as `attention=1`
 * and keeps only the runs that carry one, an instance of a workflow file carries its steps' states,
 * and the filtered list lists each step as itself.
 */
import { describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  buildRunRows,
  filterRunRows,
  parseRunFilter,
  runListRows,
  serializeRunFilter,
} from './run-rows.ts';

function rowsOf(tasks: readonly TaskView[]) {
  return runListRows(buildRunRows({ tasks, goals: [], chats: [] }));
}

describe('a row’s attention states', () => {
  test('are the task’s, in the order a badge says them, each once', () => {
    const [row] = rowsOf([
      taskFixture({ id: 'run-a', attention: ['overspending', 'stalled', 'stalled'] }),
    ]);
    expect(row?.attention).toEqual(['stalled', 'overspending']);
  });

  test('are none for a task from a Bureau that does not report them', () => {
    const [row] = rowsOf([taskFixture({ id: 'run-a' })]);
    expect(row?.attention ?? []).toEqual([]);
  });

  test('stay on a settled run that overspent', () => {
    const [row] = rowsOf([
      taskFixture({ id: 'run-a', status: 'completed', attention: ['overspending'] }),
    ]);
    expect(row?.status).toBe('completed');
    expect(row?.attention).toEqual(['overspending']);
  });

  test('of an instance are the union of its steps’ states', () => {
    const steps = ['step-1', 'step-2', 'step-3'].map((id, index) =>
      taskFixture({
        id,
        kind: 'catalog',
        origin: { kind: 'parent', parentRunId: 'instance-1' },
        createdAt: `2026-11-02T10:0${String(index)}:00.000Z`,
        attention: index === 0 ? ['looping'] : index === 1 ? ['stalled', 'looping'] : [],
      }),
    );
    const rows = rowsOf(steps);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('instance-1');
    expect(rows[0]?.attention).toEqual(['stalled', 'looping']);
  });

  test('of an instance the engine lists as a task of its own come from its steps too', () => {
    const rows = runListRows(
      buildRunRows({
        tasks: [
          taskFixture({ id: 'instance-1', kind: 'catalog' }),
          taskFixture({
            id: 'step-1',
            kind: 'catalog',
            origin: { kind: 'parent', parentRunId: 'instance-1' },
            attention: ['overspending'],
          }),
        ],
        goals: [],
        chats: [],
      }),
    );
    expect(rows.find((row) => row.id === 'instance-1')?.attention).toEqual(['overspending']);
  });
});

describe('the Needs attention filter', () => {
  test('is kept in the address as attention=1 and read back from it', () => {
    expect(parseRunFilter(new URLSearchParams('attention=1'))).toEqual({ attention: true });
    expect(serializeRunFilter({ attention: true, status: 'running' })).toBe(
      'attention=1&status=running',
    );
    const filter = parseRunFilter(new URLSearchParams('attention=1&agent=assistant&q=refund'));
    expect(parseRunFilter(new URLSearchParams(serializeRunFilter(filter)))).toEqual(filter);
  });

  test('is no filter for a value it does not know', () => {
    expect(parseRunFilter(new URLSearchParams('attention=yes'))).toEqual({});
    expect(parseRunFilter(new URLSearchParams('attention='))).toEqual({});
  });

  test('keeps the runs that carry a state, a settled one that overspent included', () => {
    const rows = rowsOf([
      taskFixture({ id: 'quiet' }),
      taskFixture({ id: 'stalled', attention: ['stalled'] }),
      taskFixture({ id: 'settled', status: 'completed', attention: ['overspending'] }),
    ]);
    expect(filterRunRows(rows, { attention: true }).map((row) => row.id)).toEqual(
      expect.arrayContaining(['stalled', 'settled']),
    );
    expect(filterRunRows(rows, { attention: true })).toHaveLength(2);
    expect(filterRunRows(rows, {})).toHaveLength(3);
  });
});

describe('the list under the Needs attention filter', () => {
  const stepOf = (id: string, status: TaskView['status'], attention: TaskView['attention']) =>
    taskFixture({
      id,
      kind: 'catalog',
      status,
      attention,
      origin: { kind: 'parent', parentRunId: 'instance-1' },
    });

  test('lists each step as itself, because an instance made of some of its steps would misstate it', () => {
    const tasks = [
      stepOf('step-1', 'working', ['stalled']),
      stepOf('step-2', 'completed', ['overspending']),
    ];
    const unfolded = runListRows(buildRunRows({ tasks, goals: [], chats: [] }), {
      foldSteps: false,
    });
    expect(unfolded.map((row) => row.id).toSorted()).toEqual(['step-1', 'step-2']);
    expect(unfolded.map((row) => row.status).toSorted()).toEqual(['completed', 'working']);
    expect(unfolded.find((row) => row.id === 'step-1')?.attention).toEqual(['stalled']);
  });

  test('folds the steps into their instance by default', () => {
    const tasks = [stepOf('step-1', 'working', ['stalled']), stepOf('step-2', 'completed', [])];
    expect(runListRows(buildRunRows({ tasks, goals: [], chats: [] })).map((row) => row.id)).toEqual(
      ['instance-1'],
    );
  });
});
