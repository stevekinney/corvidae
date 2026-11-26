import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, test } from 'bun:test';

import { HttpClientError, type WorkflowTimelineEntry } from '@lostgradient/weft';

import { fetchWorkflowTimeline, signalHistoryFromTimeline } from './workflow-timeline-data.ts';

test('reads nested generated timeline branches and preserves missing and forbidden faults', async () => {
  const branch = {
    index: 1,
    operationId: 'one',
    operationType: 'activity',
    operationLabel: 'One',
    outcome: 'won' as const,
  };
  const result = [
    entry({
      branches: [{ ...branch, branches: [branch] }],
      versionTuple: { workflowVersion: '1', toolVersions: ['tool@1'] },
    }),
  ];
  let asked: unknown;
  const client = {
    operations: {
      'weft.workflows.timeline.get': async (input: unknown) => {
        asked = input;
        return result;
      },
    },
  };
  expect(await fetchWorkflowTimeline(client, 'run')).toEqual(result);
  expect(asked).toEqual({ workflowId: 'run' });
  const missing = {
    operations: {
      'weft.workflows.timeline.get': async () => {
        throw new HttpClientError(404, 'missing');
      },
    },
  };
  expect(await fetchWorkflowTimeline(missing, 'run')).toEqual([]);
  const forbidden = {
    operations: {
      'weft.workflows.timeline.get': async () => {
        throw new HttpClientError(403, 'forbidden');
      },
    },
  };
  expect(await rejectionOf(fetchWorkflowTimeline(forbidden, 'run'))).toMatchObject({ status: 403 });
});

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 1,
    operationType: 'activity',
    operationLabel: 'doThing',
    inputSummary: '{}',
    timestamp: 1000,
    status: 'completed',
    ...overrides,
  };
}

describe('signalHistoryFromTimeline', () => {
  test('extracts only wait-signal entries, in timeline order', () => {
    const entries = [
      entry({
        step: 1,
        operationType: 'wait-signal',
        operationLabel: 'advance',
        status: 'completed',
      }),
      entry({ step: 2, operationType: 'activity', operationLabel: 'recordStep' }),
      entry({
        step: 3,
        operationType: 'wait-signal',
        operationLabel: 'advance',
        status: 'running',
      }),
    ];

    const rows = signalHistoryFromTimeline(entries);

    expect(rows).toEqual([
      { step: 1, name: 'advance', status: 'completed', timestamp: 1000 },
      { step: 3, name: 'advance', status: 'running', timestamp: 1000 },
    ]);
  });

  test('empty timeline yields no rows', () => {
    expect(signalHistoryFromTimeline([])).toEqual([]);
  });

  test('a timeline with no wait-signal entries yields no rows', () => {
    const entries = [entry({ operationType: 'activity' }), entry({ operationType: 'sleep' })];
    expect(signalHistoryFromTimeline(entries)).toEqual([]);
  });
});
