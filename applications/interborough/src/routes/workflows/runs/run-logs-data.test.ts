import { describe, expect, test } from 'bun:test';

import { RUN_LOG_CASES, linesOf } from './run-log-cases.test-support.ts';
import {
  fetchRunLogs,
  placeLogLines,
  workflowLogsQueryKey,
  type LogPlacement,
  type RunLogLine,
} from './run-logs-data.ts';

function line(
  sequence: number,
  step: number | null,
  message = `line ${String(sequence)}`,
): RunLogLine {
  return {
    sequence,
    step,
    level: 'info',
    message,
    timestamp: 1_000 + sequence,
    workflowType: 'work',
    truncated: false,
  };
}

describe('fetchRunLogs', () => {
  test('reads the run’s lines and what was dropped', async () => {
    const calls: unknown[] = [];
    const result = await fetchRunLogs(
      {
        operations: {
          'weft.workflows.logs.list': async (input) => {
            calls.push(input);
            return { lines: [line(0, 0)], dropped: 4 };
          },
        },
      },
      'run-1',
    );
    expect(calls).toEqual([{ workflowId: 'run-1' }]);
    expect(result.dropped).toBe(4);
    expect(result.lines).toHaveLength(1);
  });

  test('has no lines for an engine that does not offer them', async () => {
    expect(await fetchRunLogs({ operations: {} }, 'run-1')).toEqual({ lines: [], dropped: 0 });
  });

  test('keys the query by run', () => {
    expect(workflowLogsQueryKey('a')).not.toEqual(workflowLogsQueryKey('b'));
  });
});

/** A timeline entry as placement reads it: its checkpoint key and the step index its lines carry. */
function entry(step: number, stepIndex: number | undefined) {
  return { step, stepIndex };
}

/** Lines named after what they were logged in front of, with the step the engine stamped. */
function lines(...stamped: Array<[string, number | null]>): RunLogLine[] {
  return stamped.map(([message, step], sequence) => line(sequence, step, message));
}

/** What each part of the placement holds, as messages, for a readable assertion. */
function messages(placement: LogPlacement): unknown {
  if (placement.kind === 'whole-run') return 'whole-run';
  return {
    beforeFirst: placement.beforeFirst.map((each) => each.message),
    byStep: [...placement.byStep].map(([step, grouped]) => [step, grouped.map((l) => l.message)]),
  };
}

describe('placeLogLines', () => {
  for (const runCase of RUN_LOG_CASES) {
    test(`places the lines of ${runCase.name} under the steps they belong to`, () => {
      expect(messages(placeLogLines(runCase.entries, linesOf(runCase)))).toEqual({
        beforeFirst: runCase.beforeFirst,
        byStep: runCase.byStep,
      });
    });
  }

  test('places every line of every case exactly once', () => {
    for (const runCase of RUN_LOG_CASES) {
      const placement = placeLogLines(runCase.entries, linesOf(runCase));
      if (placement.kind !== 'by-step') throw new Error('expected the lines to be placed');
      const placed = [...placement.beforeFirst, ...[...placement.byStep.values()].flat()].map(
        (each) => each.sequence,
      );
      expect(placed.sort((first, second) => first - second)).toEqual(
        runCase.lines.map((_, sequence) => sequence),
      );
    }
  });

  test('a step index several entries share goes to the earliest entry by checkpoint key, whatever the order given', () => {
    const placement = placeLogLines([entry(4, 0), entry(0, 0), entry(2, 1)], lines(['in', 0]));
    expect(messages(placement)).toEqual({ beforeFirst: [], byStep: [[0, ['in']]] });
  });

  test('keeps lines in the order logged inside a step', () => {
    const placement = placeLogLines([entry(0, 0)], lines(['one', 0], ['two', 0], ['three', 0]));
    expect(messages(placement)).toEqual({
      beforeFirst: [],
      byStep: [[0, ['one', 'two', 'three']]],
    });
  });

  test('a run with no steps puts every line before the first', () => {
    expect(messages(placeLogLines([], lines(['a', 0], ['b', 1])))).toEqual({
      beforeFirst: ['a', 'b'],
      byStep: [],
    });
  });

  test('shows the whole run when an entry has no step index, as a run recorded before the field was', () => {
    expect(messages(placeLogLines([entry(0, 0), entry(1, undefined)], lines(['a', 0])))).toBe(
      'whole-run',
    );
  });

  test('shows the whole run when a line has no step', () => {
    expect(messages(placeLogLines([entry(0, 0)], lines(['a', 0], ['b', null])))).toBe('whole-run');
  });
});
