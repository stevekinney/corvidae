/**
 * The Run inspector under How it ran (COR-2424, row 54i): five rows about where a run stands,
 * written from the task the page holds.
 */
import { describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { dayStamp } from '../../../lib/format/clock.ts';
import { runInspectorRows } from './run-inspector.ts';

function valuesOf(rows: ReturnType<typeof runInspectorRows>): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.label, row.value]));
}

describe('the Run inspector rows', () => {
  test('say a finished run has nothing left to do, nothing it waits on, and nothing to clean up (row 54i)', () => {
    const task = taskFixture({ status: 'completed', updatedAt: '2026-10-30T11:20:23.000Z' });

    const rows = runInspectorRows({ task, followState: 'ended' });

    expect(rows.map((row) => row.label)).toEqual([
      'Progress',
      'Waiting on',
      'Liveness',
      'Event stream',
      'Cleanup',
    ]);
    expect(valuesOf(rows)).toEqual({
      Progress: 'Finished; nothing left to do',
      'Waiting on': 'Nothing',
      Liveness: `No signals; the run ended ${dayStamp(Date.parse('2026-10-30T11:20:23.000Z'))}`,
      'Event stream': 'Up to date',
      Cleanup: 'None needed',
    });
  });

  test('name what a run waits on: a person’s answer, a person’s approval, or a signal', () => {
    const waiting = (wait: unknown) =>
      taskFixture({ status: 'input-required', openWaits: [wait as never] });

    expect(
      valuesOf(
        runInspectorRows({
          task: waiting({ kind: 'human-wait', reviewId: 'r', signalName: 's' }),
          followState: 'live',
        }),
      )['Waiting on'],
    ).toBe('Your answer');
    expect(
      valuesOf(
        runInspectorRows({
          task: waiting({ kind: 'tool-approval', reviewId: 'r', callId: 'c' }),
          followState: 'live',
        }),
      )['Waiting on'],
    ).toBe('Your approval');
    expect(
      valuesOf(
        runInspectorRows({
          task: taskFixture({ status: 'working' }),
          followState: 'live',
          waitingForSignals: ['notes-approved'],
        }),
      )['Waiting on'],
    ).toBe('The signal notes-approved');
  });

  test('say a run going on reports progress, and where the page’s follow of it stands', () => {
    const task = taskFixture({ status: 'working' });

    expect(valuesOf(runInspectorRows({ task, followState: 'live' }))).toMatchObject({
      Progress: 'Working',
      Liveness: 'Working; it is reporting progress',
      'Event stream': 'Live',
    });
    expect(valuesOf(runInspectorRows({ task, followState: 'reconnecting' }))['Event stream']).toBe(
      'Reconnecting',
    );
    expect(valuesOf(runInspectorRows({ task, followState: 'unavailable' }))['Event stream']).toBe(
      'Not available',
    );
  });

  test('say where a cancellation’s cleanup stands', () => {
    const task = taskFixture({ status: 'canceled', cleanup: 'cleanup-pending' });

    expect(valuesOf(runInspectorRows({ task, followState: 'ended' }))).toMatchObject({
      Progress: 'Stopped; it was canceled',
      Cleanup: 'Cleaning up after the cancel',
    });
  });
});
