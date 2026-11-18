import { describe, expect, test } from 'bun:test';

import { TASK_COPY } from '../../app/copy/tasks.ts';
import { runLineTwo, runSegmentCounts, runStatusWord } from '../workflows/runs/run-rows.ts';
import {
  workflowRunOrigin,
  workflowRunRow,
  workflowRunRows,
  workflowRunState,
  type WorkflowRunSummary,
} from './workflow-run-rows.ts';

const CONTEXT = { title: 'Release notes', agentName: 'writer' } as const;

function summary(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'run-1',
    status: 'completed',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_003_000,
    origin: null,
    ...overrides,
  };
}

describe('the state an instance reads as', () => {
  test.each([
    ['pending', 'submitted'],
    ['running', 'working'],
    ['suspended', 'input-required'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['timed-out', 'failed'],
    ['cancelled', 'canceled'],
  ] as const)('%s reads as %s', (status, state) => {
    expect(workflowRunState(status)).toBe(state);
  });

  test('counts a suspended instance under Waiting, never under Running', () => {
    const rows = workflowRunRows([summary({ id: 'waiting', status: 'suspended' })], CONTEXT);
    const counts = runSegmentCounts(rows);
    expect(counts.waiting).toBe(1);
    expect(counts.running).toBe(0);
  });
});

describe('one instance as a row', () => {
  test('is titled with the workflow, run by its agent, and took as long as it ran', () => {
    const row = workflowRunRow(summary({ status: 'failed' }), CONTEXT);
    expect(row.title).toBe('Release notes');
    expect(row.agentName).toBe('writer');
    expect(row.durationMs).toBe(3000);
    expect(runStatusWord(row)).toBe('Failed');
  });

  test('names the calling agent for an instance an agent’s tool call started', () => {
    const row = workflowRunRow(
      summary({ origin: { kind: 'agent-run', agentId: 'journey-author', runId: 'calling-run-1' } }),
      CONTEXT,
    );
    expect(row.agentName).toBe('journey-author');
  });

  test('names a trigger-started instance by its origin, its plugin and its file kept, and says a trigger started it on line two', () => {
    const row = workflowRunRow(
      summary({ origin: { kind: 'trigger', plugin: 'linear', workflowId: 'sync' } }),
      CONTEXT,
    );
    // COR-2171: the projection keeps the plugin and the file, so the row can say which trigger.
    expect(row.origin).toEqual({
      kind: 'trigger',
      plugin: 'linear',
      workflowId: 'sync',
      href: '/workflows/sync',
    });
    const line = runLineTwo(row, {
      now: 1_760_000_010_000,
      zone: 'America/Chicago',
      agentLabel: (name) => name,
    });
    expect(line.startsWith(TASK_COPY.list.kinds.trigger)).toBe(true);
  });

  test('names the trigger’s plugin by its title in the who slot of a run whose workflow names no agent, never "An agent" (COR-2171)', () => {
    const row = workflowRunRow(
      summary({ origin: { kind: 'trigger', plugin: 'linear', workflowId: 'sync' } }),
      { title: 'Sync', agentName: null },
    );
    const line = runLineTwo(row, {
      now: 1_760_000_010_000,
      zone: 'America/Chicago',
      agentLabel: (name) => name,
      pluginTitle: (plugin) => (plugin === 'linear' ? 'Linear' : undefined),
    });
    expect(line).toBe(
      [TASK_COPY.list.kinds.trigger, 'Linear', '3 s'].join(TASK_COPY.list.separator),
    );
    expect(line).not.toContain(TASK_COPY.unknownAgent);
  });

  test('says the plugin’s identifier only when no title is loaded for it (COR-2171)', () => {
    const row = workflowRunRow(
      summary({ origin: { kind: 'trigger', plugin: 'linear', workflowId: 'sync' } }),
      { title: 'Sync', agentName: null },
    );
    const context = {
      now: 1_760_000_010_000,
      zone: 'America/Chicago',
      agentLabel: (n: string) => n,
    };
    expect(runLineTwo(row, context)).toContain(', linear, ');
    expect(runLineTwo(row, { ...context, pluginTitle: () => undefined })).toContain(', linear, ');
  });

  test('has no duration while it is still going', () => {
    expect(workflowRunRow(summary({ status: 'running' }), CONTEXT).durationMs).toBeNull();
  });

  test('says on line two what started it, the agent and how long it took, kind first', () => {
    const row = workflowRunRow(
      summary({ origin: { kind: 'schedule', scheduleId: 'nightly', fireId: 'fire-1' } }),
      CONTEXT,
    );
    const line = runLineTwo(row, {
      now: 1_760_000_010_000,
      zone: 'America/Chicago',
      agentLabel: (name) => (name === 'writer' ? 'Assistant' : name),
    });
    expect(line).toBe(
      [TASK_COPY.list.kinds.schedule, 'Assistant', '3 s'].join(TASK_COPY.list.separator),
    );
  });
});

describe('what started an instance', () => {
  test('is none when the Bureau recorded nothing', () => {
    expect(workflowRunOrigin(null)).toEqual({ kind: 'none' });
    expect(workflowRunOrigin(undefined)).toEqual({ kind: 'none' });
  });

  test('names the schedule and links its page', () => {
    expect(
      workflowRunOrigin({ kind: 'schedule', scheduleId: 'nightly', fireId: 'f', manual: true }),
    ).toEqual({
      kind: 'schedule',
      title: '',
      href: '/schedules/nightly',
      scheduleId: 'nightly',
      schedulePath: '/schedules/nightly',
      manual: true,
    });
  });

  test('names an agent tool call by its agent and its calling run', () => {
    expect(
      workflowRunOrigin({ kind: 'agent-run', agentId: 'journey-author', runId: 'calling-run-1' }),
    ).toEqual({
      kind: 'agent-run',
      agentName: 'journey-author',
      runId: 'calling-run-1',
      href: '/runs/calling-run-1',
    });
  });

  test('keeps the surface a person started it from', () => {
    expect(workflowRunOrigin({ kind: 'person', principal: 'local', surface: 'web' })).toEqual({
      kind: 'person',
      surface: 'web',
    });
  });
});

describe('the rows of a workflow', () => {
  test('list the most recently started first', () => {
    const rows = workflowRunRows(
      [summary({ id: 'older', createdAt: 1_000 }), summary({ id: 'newer', createdAt: 2_000 })],
      CONTEXT,
    );
    expect(rows.map((row) => row.id)).toEqual(['newer', 'older']);
  });
});

describe('COR-2431: how far an instance got, what it waits for, and why it failed', () => {
  const FILE = {
    ...CONTEXT,
    agentName: null,
    type: 'release-notes',
    scheduleNames: new Map([['schedule-1', 'Release notes digest']]),
  } as const;
  const LINE = { now: 1_760_000_010_000, zone: 'America/Chicago', agentLabel: (n: string) => n };

  test('a failed scheduled run names its schedule, the step it failed at, and what it said (row 62n)', () => {
    const row = workflowRunRow(
      summary({
        status: 'failed',
        origin: { kind: 'schedule', scheduleId: 'schedule-1', fireId: 'fire-1' },
        steps: { total: 4, at: 2 },
        failure: 'GitHub didn’t answer',
      }),
      FILE,
    );
    expect(runStatusWord(row)).toBe('Failed');
    expect(runLineTwo(row, LINE)).toBe(
      [
        TASK_COPY.list.kinds.schedule,
        'Release notes digest',
        TASK_COPY.list.failedAtStep(2, 4),
        'GitHub didn’t answer',
        '3 s',
      ].join(TASK_COPY.list.separator),
    );
  });

  test('a run parked at a signal reads Waiting, counts under the signal segment, and names the signal (row 63o)', () => {
    const rows = workflowRunRows(
      [
        summary({
          status: 'suspended',
          origin: { kind: 'person', principal: 'local', surface: 'web' },
          steps: { total: 4, at: 4 },
          awaitingSignal: 'notes-approved',
        }),
      ],
      FILE,
    );
    const [row] = rows;
    if (row === undefined) throw new Error('Expected one row');
    expect(runStatusWord(row)).toBe('Waiting');
    const counts = runSegmentCounts(rows);
    expect(counts.signal).toBe(1);
    expect(counts.waiting).toBe(0);
    expect(counts.running).toBe(0);
    const line = runLineTwo(row, LINE);
    expect(line).toContain(TASK_COPY.list.waitingForSignal('notes-approved'));
    // Off its page it says nothing of its step (10h); on its own workflow's page, how far it got
    // follows what it waits for (row 63o).
    expect(line).not.toContain(TASK_COPY.list.stepOf(4, 4));
    expect(runLineTwo(row, { ...LINE, withinWorkflow: true })).toContain(
      `${TASK_COPY.list.waitingForSignal('notes-approved')}${TASK_COPY.list.separator}${TASK_COPY.list.stepOf(4, 4)}`,
    );
  });

  test('a run waiting for a person (no awaited signal) is Waiting on you, never the hollow Waiting', () => {
    const rows = workflowRunRows(
      [summary({ status: 'suspended', steps: { total: 2, at: 2 }, awaitingSignal: null })],
      FILE,
    );
    const [row] = rows;
    if (row === undefined) throw new Error('Expected one row');
    expect(runStatusWord(row)).toBe('Waiting on you');
    expect(runSegmentCounts(rows).waiting).toBe(1);
    expect(runSegmentCounts(rows).signal).toBe(0);
  });

  test('on its workflow’s page a run a person started reads "Workflow, You", the signal before the step (row 63o)', () => {
    const [row] = workflowRunRows(
      [
        summary({
          status: 'suspended',
          origin: { kind: 'person', principal: 'local', surface: 'web' },
          steps: { total: 4, at: 4 },
          awaitingSignal: 'notes-approved',
        }),
      ],
      FILE,
    );
    if (row === undefined) throw new Error('Expected one row');
    expect(runLineTwo(row, { ...LINE, withinWorkflow: true })).toBe(
      'Workflow, You, waiting for the signal notes-approved, step 4 of 4',
    );
  });

  test('on its workflow’s page a scheduled run says its agent and when the schedule runs, and a failed one its schedule (rows 63p, 62n)', () => {
    const scheduled = { kind: 'schedule', scheduleId: 'schedule-1', fireId: 'fire-1' } as const;
    const context = {
      ...LINE,
      withinWorkflow: true,
      scheduleCadence: (id: string) => (id === 'schedule-1' ? 'every day at 8:00 AM' : undefined),
    };
    const done = workflowRunRow(summary({ origin: scheduled, steps: { total: 3, at: 3 } }), {
      ...FILE,
      agentName: 'Assistant',
    });
    expect(runLineTwo(done, context)).toBe('Schedule, Assistant, every day at 8:00 AM, 3 s');
    const failed = workflowRunRow(
      summary({
        status: 'failed',
        origin: scheduled,
        steps: { total: 4, at: 2 },
        failure: 'GitHub didn’t answer',
      }),
      { ...FILE, agentName: 'Assistant' },
    );
    expect(runLineTwo(failed, context)).toBe(
      'Schedule, Release notes digest, failed at step 2 of 4, GitHub didn’t answer, 3 s',
    );
  });

  test('a row with no workflow type says none of them, as before', () => {
    const row = workflowRunRow(
      summary({ status: 'failed', steps: { total: 4, at: 2 }, failure: 'boom' }),
      CONTEXT,
    );
    expect(row.workflow).toBeUndefined();
    expect(runLineTwo(row, LINE)).not.toContain(TASK_COPY.list.failedAtStep(2, 4));
  });
});
