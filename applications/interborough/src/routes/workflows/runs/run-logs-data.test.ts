import { describe, expect, test } from 'bun:test';

import { fetchRunLogs, workflowLogsQueryKey, type RunLogLine } from './run-logs-data.ts';

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
