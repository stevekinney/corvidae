/**
 * COR-1806 — the action a topology child leaves on its parent run, which the AG-UI mount projects.
 */
import { describe, expect, it } from 'bun:test';

import { announceChildOnParent, childActionOf } from './child-announcement.ts';
import { ChildWorkflowFailedRecordedEvent } from './events.ts';
import type { BureauChildRecord } from './child-topology-store.ts';

function record(overrides: Partial<BureauChildRecord> = {}): BureauChildRecord {
  return {
    schemaVersion: 2,
    parentRunId: 'parent-1',
    childRunId: 'child-1',
    parentAgentName: 'assistant',
    childAgentName: 'worker',
    status: 'running',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    recoveries: 0,
    workflow: { kind: 'process-local' },
    parentCancellation: 'cascade',
    ...overrides,
  };
}

const correlation = {
  parentAgentName: 'assistant',
  parentRunId: 'parent-1',
  childAgentName: 'worker',
  childRunId: 'child-1',
};

describe('childActionOf', () => {
  it('records a started child as Operative’s started event, durable as its workflow is', () => {
    expect(childActionOf({ kind: 'started', record: record() })).toEqual({
      type: 'multiagent.child-workflow.started',
      detail: { ...correlation, durable: false },
    });
    expect(
      childActionOf({
        kind: 'started',
        record: record({
          workflow: { kind: 'durable', workflowType: 'agentRun', workflowId: 'child-1' },
        }),
      })?.detail,
    ).toMatchObject({ durable: true });
  });

  it('records each way a child ends as the matching terminal event', () => {
    expect(childActionOf({ kind: 'settled', record: record({ status: 'completed' }) })).toEqual({
      type: 'multiagent.child-workflow.completed',
      detail: correlation,
    });
    expect(
      childActionOf({
        kind: 'settled',
        record: record({ status: 'failed', outcome: { reason: 'boom' } }),
      }),
    ).toEqual({
      type: 'multiagent.child-workflow.failed',
      detail: { ...correlation, reason: 'boom' },
    });
    expect(
      childActionOf({ kind: 'settled', record: record({ status: 'failed' }) })?.detail,
    ).toEqual({ ...correlation, reason: 'failed' });
    expect(
      childActionOf({
        kind: 'settled',
        record: record({ status: 'aborted', outcome: { reason: 'parent cancelled' } }),
      }),
    ).toEqual({
      type: 'multiagent.child-workflow.aborted',
      detail: { ...correlation, reason: 'parent cancelled' },
    });
  });

  it('records nothing for a settlement whose record is still running', () => {
    expect(childActionOf({ kind: 'settled', record: record() })).toBeUndefined();
  });
});

describe('announceChildOnParent (COR-2097)', () => {
  function fakeStore(onStore: boolean) {
    const recorded: Array<{ runId: string; type: string }> = [];
    return {
      recorded,
      store: {
        getRun: (runId: string) => (onStore && runId === 'parent-1' ? {} : undefined),
        recordAction: (runId: string, type: string) => recorded.push({ runId, type }),
      },
    };
  }

  it('records the action on a parent that is on the store, and publishes nothing itself', () => {
    const { store, recorded } = fakeStore(true);
    const dispatched: Event[] = [];

    announceChildOnParent(
      { kind: 'started', record: record() },
      store,
      (event) => dispatched.push(event),
      () => 7,
    );

    expect(recorded).toEqual([{ runId: 'parent-1', type: 'multiagent.child-workflow.started' }]);
    expect(dispatched).toEqual([]);
  });

  it('publishes the event itself for a parent that is not on the store, and records nothing', () => {
    const { store, recorded } = fakeStore(false);
    const dispatched: Event[] = [];

    announceChildOnParent(
      { kind: 'settled', record: record({ status: 'failed', outcome: { reason: 'boom' } }) },
      store,
      (event) => dispatched.push(event),
      () => 7,
    );

    expect(recorded).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toBeInstanceOf(ChildWorkflowFailedRecordedEvent);
    expect((dispatched[0] as ChildWorkflowFailedRecordedEvent).action).toMatchObject({
      runId: 'parent-1',
      type: 'multiagent.child-workflow.failed',
      timestamp: 7,
    });
  });

  it('announces nothing for a settlement that is not terminal', () => {
    const { store, recorded } = fakeStore(false);
    const dispatched: Event[] = [];

    announceChildOnParent(
      { kind: 'settled', record: record() },
      store,
      (event) => dispatched.push(event),
      () => 7,
    );

    expect([recorded, dispatched]).toEqual([[], []]);
  });
});
