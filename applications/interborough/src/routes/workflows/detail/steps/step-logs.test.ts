import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import {
  fetchRunLogs,
  linesByTimelineStep,
  workflowLogsQueryKey,
  type RunLogLine,
} from './step-logs.ts';

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

type EntryOverrides = { [K in keyof WorkflowTimelineEntry]?: WorkflowTimelineEntry[K] | undefined };

function entry(step: number, overrides: EntryOverrides = {}): WorkflowTimelineEntry {
  // A key set to `undefined` stands for an entry the engine reported without it.
  return {
    step,
    operationType: 'activity',
    operationLabel: `op${String(step)}`,
    inputSummary: '{}',
    timestamp: 1_000 + step,
    status: 'completed',
    ...overrides,
  } as WorkflowTimelineEntry;
}

function branches(count: number): NonNullable<WorkflowTimelineEntry['branches']> {
  return Array.from({ length: count }, (_, index) => ({
    index,
    operationId: `b${String(index)}`,
    operationType: 'activity',
    operationLabel: `branch${String(index)}`,
    outcome: 'fulfilled' as const,
  }));
}

describe('linesByTimelineStep', () => {
  test('gives a step the lines logged just before it ran, in the order they were logged', () => {
    // The timeline counts from 1; a line counts the operations completed so far, from 0.
    const grouped = linesByTimelineStep(
      [line(0, 0), line(1, 1), line(2, 1), line(3, 2)],
      [entry(1), entry(2), entry(3)],
    );
    expect(grouped.get(1)?.map((found) => found.sequence)).toEqual([0]);
    expect(grouped.get(2)?.map((found) => found.sequence)).toEqual([1, 2]);
    expect(grouped.get(3)?.map((found) => found.sequence)).toEqual([3]);
  });

  test('counts a group of branches as the group and each branch, so later lines still find their step', () => {
    // A race of three branches is operations 0 to 3, so a line logged after it has step 4.
    const entries = [
      entry(1, { operationType: 'race', branches: branches(3) }),
      entry(2),
      entry(3),
    ];
    const grouped = linesByTimelineStep([line(0, 0), line(1, 4), line(2, 5)], entries);
    expect(grouped.get(1)?.map((found) => found.sequence)).toEqual([0]);
    expect(grouped.get(2)?.map((found) => found.sequence)).toEqual([1]);
    expect(grouped.get(3)?.map((found) => found.sequence)).toEqual([2]);
  });

  test('counts the branches an entry left out, and places a line logged inside a group with the group', () => {
    const entries = [
      entry(1, { operationType: 'parallel', branches: branches(2), branchesOmitted: 3 }),
      entry(2),
    ];
    const grouped = linesByTimelineStep([line(0, 2), line(1, 6)], entries);
    expect(grouped.get(1)?.map((found) => found.sequence)).toEqual([0]);
    expect(grouped.get(2)?.map((found) => found.sequence)).toEqual([1]);
  });

  test('stops at a group whose branches were not reported, since nothing after it can be placed', () => {
    const entries = [entry(1), entry(2, { operationType: 'race' }), entry(3)];
    const grouped = linesByTimelineStep([line(0, 0), line(1, 1), line(2, 2)], entries);
    expect([...grouped.keys()]).toEqual([1]);
  });

  test('leaves a line past the last step, or stored without a step, to the run’s whole log', () => {
    const grouped = linesByTimelineStep([line(0, null), line(1, 2)], [entry(1), entry(2)]);
    expect(grouped.size).toBe(0);
  });

  test('walks the timeline in step order whatever order it arrives in', () => {
    const grouped = linesByTimelineStep([line(0, 1)], [entry(2), entry(1)]);
    expect(grouped.get(2)?.map((found) => found.sequence)).toEqual([0]);
  });

  test('has nothing to place against an empty timeline', () => {
    expect(linesByTimelineStep([line(0, 0)], []).size).toBe(0);
  });
});

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
