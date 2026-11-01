/**
 * Which service writes each kind of schedule, and what each can be asked to do
 * (`schedule-writes.ts`). The component tests drive the writes themselves; this pins the table and
 * the refusals that no screen reaches, because a schedule is never written through the wrong service
 * for want of knowing which owns it.
 */
import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing';
import { HttpClient } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { ScheduleKind } from '../../lib/schedule-kinds.ts';
import type { WorkflowFileListing } from '../../lib/workflow-files.ts';
import {
  actionsOf,
  cancelTarget,
  missedOf,
  pauseTarget,
  resumeTarget,
  runNowTarget,
  skipNextTarget,
  StaleScheduleError,
  type ScheduleTarget,
} from './schedule-writes.ts';

const FILE: WorkflowFileListing = {
  id: 'digest',
  state: 'ready',
  owner: 'anonymous:local',
  hash: 'hash-1',
  description: null,
  agent: 'assistant',
  paused: false,
  inputSchema: null,
  outputSchema: null,
  version: 'v1',
  trigger: { kind: 'schedule', spec: '1h' },
  runs: { active: 0, last24Hours: 0, lastRunAt: null },
  problem: null,
};

const target = (
  kind: ScheduleKind,
  status: 'active' | 'paused' | 'cancelled' = 'active',
): ScheduleTarget => ({ schedule: { id: 's-1', revision: 3, status, nextFireAt: 1000 }, kind });

const client = new HttpClient({ baseUrl: 'http://localhost/api' });

describe('what a schedule can be asked to do', () => {
  test('an agent run and a code-defined schedule can be paused or resumed by status, edited, and cancelled', () => {
    for (const kind of [{ kind: 'agent-run', agentName: 'assistant' }, { kind: 'code' }] as const) {
      expect(actionsOf(target(kind, 'active'))).toEqual({
        pause: true,
        resume: false,
        cancel: true,
        skipNext: true,
        runNow: true,
        edit: true,
        editInWorkflow: false,
      });
      // A paused schedule has no next fire to skip, and can still be run.
      expect(actionsOf(target(kind, 'paused'))).toMatchObject({
        pause: false,
        resume: true,
        skipNext: false,
        runNow: true,
      });
    }
  });

  test('a workflow file’s schedule can be paused and resumed while its file can be written, and is edited in the workflow', () => {
    const file = { kind: 'workflow-file', file: FILE } as const;
    expect(actionsOf(target(file, 'active'))).toEqual({
      pause: true,
      resume: false,
      cancel: false,
      skipNext: false,
      runNow: false,
      edit: false,
      editInWorkflow: true,
    });
    expect(actionsOf(target(file, 'paused'))).toMatchObject({ pause: false, resume: true });
    for (const unwritable of [
      { ...FILE, state: 'invalid' as const },
      { ...FILE, hash: null },
    ]) {
      const kind = { kind: 'workflow-file', file: unwritable } as const;
      expect(actionsOf(target(kind, 'active'))).toMatchObject({
        pause: false,
        resume: false,
        editInWorkflow: true,
      });
    }
  });

  test('a cancelled schedule, and one of no known kind, offer nothing', () => {
    const none = {
      pause: false,
      resume: false,
      cancel: false,
      skipNext: false,
      runNow: false,
      edit: false,
      editInWorkflow: false,
    };
    expect(actionsOf(target({ kind: 'code' }, 'cancelled'))).toEqual(none);
    expect(actionsOf(target({ kind: 'unknown' }))).toEqual(none);
  });
});

describe('a write that no service owns', () => {
  test('is refused for a schedule of no known kind', async () => {
    const unknown = target({ kind: 'unknown' });
    expect(await throwingRejectionOf(pauseTarget(client, unknown))).toThrow('cannot be paused');
    expect(await throwingRejectionOf(resumeTarget(client, unknown))).toThrow('cannot be resumed');
    expect(await throwingRejectionOf(cancelTarget(client, unknown))).toThrow('cannot be cancelled');
  });

  test('is refused for a workflow file’s schedule to be cancelled, which is the file’s to end', async () => {
    const refused = await throwingRejectionOf(
      cancelTarget(client, target({ kind: 'workflow-file', file: FILE })),
    );
    expect(refused).toThrow('cannot be cancelled');
  });

  test('is refused for a workflow file with no hash to name', async () => {
    const unnamed = target({ kind: 'workflow-file', file: { ...FILE, hash: null } });
    expect(await throwingRejectionOf(pauseTarget(client, unnamed))).toThrow('no hash');
    expect(await throwingRejectionOf(resumeTarget(client, unnamed))).toThrow('no hash');
  });
});

describe('the controls that skip and run', () => {
  test('are refused for a workflow file’s schedule and for one of no known kind', async () => {
    for (const kind of [{ kind: 'workflow-file', file: FILE }, { kind: 'unknown' }] as const) {
      expect(await throwingRejectionOf(skipNextTarget(client, target(kind)))).toThrow(
        'cannot be skipped',
      );
      expect(await throwingRejectionOf(runNowTarget(client, target(kind)))).toThrow(
        'cannot be run now',
      );
    }
  });
});

describe('a write to an engine schedule that moved on after it was read', () => {
  /** An engine whose `getSchedule` answers with the schedule as it is now. */
  function engineAt(
    now: {
      revision: number;
      status: 'active' | 'paused' | 'cancelled';
      nextFireAt?: number | null;
    } | null,
  ) {
    const calls: string[] = [];
    const fake = {
      getSchedule: () => Promise.resolve(now === null ? null : { nextFireAt: 1000, ...now }),
      pauseSchedule: (id: string) => Promise.resolve(void calls.push(`pause ${id}`)),
      resumeSchedule: (id: string) => Promise.resolve(void calls.push(`resume ${id}`)),
      cancelSchedule: (id: string) => Promise.resolve(void calls.push(`cancel ${id}`)),
    };
    return { calls, client: fake as unknown as HttpClient };
  }

  test('is refused as stale for each write, and nothing is written', async () => {
    const moved = engineAt({ revision: 4, status: 'active' });
    for (const write of [pauseTarget, resumeTarget, cancelTarget, skipNextTarget]) {
      expect(await rejectionOf(write(moved.client, target({ kind: 'code' })))).toBeInstanceOf(
        StaleScheduleError,
      );
    }
    expect(moved.calls).toEqual([]);
  });

  test('is refused when the status moved, or the schedule is gone', async () => {
    for (const now of [{ revision: 3, status: 'paused' as const }, null]) {
      const moved = engineAt(now);
      expect(await rejectionOf(pauseTarget(moved.client, target({ kind: 'code' })))).toBeInstanceOf(
        StaleScheduleError,
      );
      expect(moved.calls).toEqual([]);
    }
  });

  test('refuses a skip once a fire moved nextFireAt, though the revision did not move', async () => {
    // A fire moves `nextFireAt` and leaves the revision, so the run the person chose is gone.
    const fired = engineAt({ revision: 3, status: 'active', nextFireAt: 2000 });
    expect(
      await rejectionOf(skipNextTarget(fired.client, target({ kind: 'code' }))),
    ).toBeInstanceOf(StaleScheduleError);
    expect(fired.calls).toEqual([]);
    // The same fire does not stop a pause, which names no run.
    await pauseTarget(fired.client, target({ kind: 'code' }));
    expect(fired.calls).toEqual(['pause s-1']);
  });

  test('is written when the schedule is the one that was read', async () => {
    const same = engineAt({ revision: 3, status: 'active' });
    await pauseTarget(same.client, target({ kind: 'code' }));
    expect(same.calls).toEqual(['pause s-1']);
  });
});

describe('the missed fires of a schedule', () => {
  const rows = [{ occurrence: 10, reason: 'late' as const, count: 1, recordedAt: 11 }];
  const engine = {
    operations: { 'weft.schedules.missed': () => Promise.resolve({ missed: rows }) },
  } as unknown as Parameters<typeof missedOf>[0];

  test('are read from the engine for a schedule that runs a workflow', async () => {
    expect(await missedOf(engine, { id: 's-1', workflowType: 'order-processing' })).toEqual(rows);
  });
});
