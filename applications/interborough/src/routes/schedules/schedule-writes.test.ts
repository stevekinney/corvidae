/**
 * Which service writes each kind of schedule, and what each can be asked to do
 * (`schedule-writes.ts`). The component tests drive the writes themselves; this pins the table and
 * the refusals that no screen reaches, because a schedule is never written through the wrong service
 * for want of knowing which owns it.
 */
import { throwingRejectionOf } from '@lostgradient/testing';
import { HttpClient } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { ScheduleKind } from '../../lib/schedule-kinds.ts';
import type { WorkflowFileListing } from '../../lib/workflow-files.ts';
import {
  actionsOf,
  cancelTarget,
  pauseTarget,
  resumeTarget,
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
  version: 'v1',
  trigger: { kind: 'schedule', spec: '1h' },
  runs: { active: 0, last24Hours: 0, lastRunAt: null },
  problem: null,
};

const target = (
  kind: ScheduleKind,
  status: 'active' | 'paused' | 'cancelled' = 'active',
): ScheduleTarget => ({ schedule: { id: 's-1', revision: 3, status }, kind });

const client = new HttpClient({ baseUrl: 'http://localhost/api' });

describe('what a schedule can be asked to do', () => {
  test('an agent run and a code-defined schedule can be paused or resumed by status, edited, and cancelled', () => {
    for (const kind of [{ kind: 'agent-run', agentName: 'assistant' }, { kind: 'code' }] as const) {
      expect(actionsOf(target(kind, 'active'))).toEqual({
        pause: true,
        resume: false,
        cancel: true,
        edit: true,
        editInWorkflow: false,
      });
      expect(actionsOf(target(kind, 'paused'))).toMatchObject({ pause: false, resume: true });
    }
  });

  test('a workflow file’s schedule can be paused and resumed while its file can be written, and is edited in the workflow', () => {
    const file = { kind: 'workflow-file', file: FILE } as const;
    expect(actionsOf(target(file, 'active'))).toEqual({
      pause: true,
      resume: false,
      cancel: false,
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
    const none = { pause: false, resume: false, cancel: false, edit: false, editInWorkflow: false };
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
