/**
 * COR-1806 — the action a topology child leaves on its parent run, which the AG-UI mount projects.
 */
import { describe, expect, it } from 'bun:test';

import { childActionOf } from './child-announcement.ts';
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
