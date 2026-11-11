import { describe, expect, test } from 'bun:test';

import { TASK_COPY } from '../../app/copy.ts';
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
