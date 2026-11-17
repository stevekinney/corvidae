/**
 * COR-2097 — what the feed publishes of a child run, a handoff, a steering command, a failed hook
 * and a version mismatch is read field by field from the event, and a field that could be text is
 * checked on its shape at the boundary.
 */
import { WorkflowVersionMismatchEvent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { projectBureauEvent } from './bureau-event-feed.ts';
import {
  ChildWorkflowAbortedRecordedEvent,
  ChildWorkflowCompletedRecordedEvent,
  ChildWorkflowFailedRecordedEvent,
  ChildWorkflowStartedRecordedEvent,
  HandoffOccurredRecordedEvent,
  HookPlanFailedRecordedEvent,
  SteeringAppliedRecordedEvent,
  SteeringCommandFailedEvent,
  SteeringCommandRejectedEvent,
  SteeringCommandSupersededEvent,
} from './events.ts';

const CANARY = 'CANARY-2097-PROJECTION-5b1e';

const recorded = (runId: string, type: string, detail: unknown) => ({
  sequence: 3,
  runId,
  type,
  detail,
  timestamp: 1_800_000_000_000,
});

const CHILD = {
  parentAgentName: 'planner',
  parentRunId: 'run-1',
  childAgentName: 'worker',
  childRunId: 'child-1',
};

describe('a child run’s events, projected (COR-2097)', () => {
  it.each([
    [
      'started',
      ChildWorkflowStartedRecordedEvent,
      { input: `the prompt ${CANARY}`, durable: true },
    ],
    ['completed', ChildWorkflowCompletedRecordedEvent, {}],
    ['aborted', ChildWorkflowAbortedRecordedEvent, { reason: `stop ${CANARY}` }],
  ] as const)(
    'publishes %s with the parent, the child and its agent only',
    (kind, Event, extra) => {
      const projected = projectBureauEvent(
        new Event(recorded('run-1', `multiagent.child-workflow.${kind}`, { ...CHILD, ...extra })),
      );

      expect(projected).toEqual({
        kind: `multiagent.child-workflow.${kind}`,
        payload: { parentRunId: 'run-1', childRunId: 'child-1', childAgentName: 'worker' },
      });
      expect(JSON.stringify(projected)).not.toContain(CANARY);
    },
  );

  it('takes the parent from the run the event was recorded on, not from the event', () => {
    const projected = projectBureauEvent(
      new ChildWorkflowStartedRecordedEvent(
        recorded('the-real-run', 'multiagent.child-workflow.started', {
          ...CHILD,
          parentRunId: 'a-run-the-tool-made-up',
        }),
      ),
    );

    expect(projected?.payload['parentRunId']).toBe('the-real-run');
  });

  it.each([
    ['error', 'error'],
    ['tripwire', 'tripwire'],
    ['aborted', 'aborted'],
    ['stop-condition', 'stop-condition'],
    ['failed', 'error'],
    [`a message ${CANARY}`, 'error'],
    [undefined, 'error'],
    [42, 'error'],
  ])('publishes the finish reason of a failed child recorded as %j as %j', (reason, expected) => {
    const projected = projectBureauEvent(
      new ChildWorkflowFailedRecordedEvent(
        recorded('run-1', 'multiagent.child-workflow.failed', { ...CHILD, reason }),
      ),
    );

    expect(projected?.payload).toEqual({
      parentRunId: 'run-1',
      childRunId: 'child-1',
      childAgentName: 'worker',
      finishReason: expected,
    });
    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });

  it('never throws on a detail that is not an object', () => {
    for (const detail of [null, 'text', 7, undefined]) {
      expect(() =>
        projectBureauEvent(
          new ChildWorkflowCompletedRecordedEvent(
            recorded('run-1', 'multiagent.child-workflow.completed', detail),
          ),
        ),
      ).not.toThrow();
    }
  });
});

describe('a handoff, projected (COR-2097)', () => {
  it('publishes the run and the two agents, and not the session', () => {
    const projected = projectBureauEvent(
      new HandoffOccurredRecordedEvent(
        recorded('run-1', 'multiagent.handoff.occurred', {
          sourceAgentName: 'planner',
          targetAgentName: 'worker',
          sessionId: CANARY,
        }),
      ),
    );

    expect(projected).toEqual({
      kind: 'multiagent.handoff.occurred',
      payload: { runId: 'run-1', sourceAgentName: 'planner', targetAgentName: 'worker' },
    });
  });
});

describe('steering events, projected (COR-2097)', () => {
  it('publishes steering.applied with the session alone, never the effective state', () => {
    const projected = projectBureauEvent(
      new SteeringAppliedRecordedEvent(
        recorded('run-1', 'steering.applied', {
          sessionId: 'session-1',
          effective: { agentName: CANARY, model: CANARY },
        }),
      ),
    );

    expect(projected).toEqual({ kind: 'steering.applied', payload: { sessionId: 'session-1' } });
  });

  it.each([
    ['steering.rejected', SteeringCommandRejectedEvent],
    ['steering.superseded', SteeringCommandSupersededEvent],
    ['steering.failed', SteeringCommandFailedEvent],
  ] as const)('publishes %s with the session, the command and a reason', (kind, Event) => {
    const projected = projectBureauEvent(
      new Event({ sessionId: 'session-1', commandId: 'command-1', failureReason: 'policy-denied' }),
    );

    expect(projected).toEqual({
      kind,
      payload: { sessionId: 'session-1', commandId: 'command-1', failureReason: 'policy-denied' },
    });
  });

  it.each([
    ['a reason that is not one of the gate’s', `denied: ${CANARY}`],
    ['an empty reason', ''],
    ['a reason that is not a string', 7],
  ])('does not publish %s', (_name, reason) => {
    const projected = projectBureauEvent(
      new SteeringCommandRejectedEvent({
        sessionId: 'session-1',
        failureReason: reason as string,
      }),
    );

    expect(projected?.payload).toEqual({ sessionId: 'session-1' });
    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });

  it('does not publish a command id that is more than one token', () => {
    const projected = projectBureauEvent(
      new SteeringCommandSupersededEvent({
        sessionId: 'session-1',
        commandId: `please ${CANARY} and then`,
        failureReason: 'superseded-by',
      }),
    );

    expect(projected?.payload).toEqual({ sessionId: 'session-1', failureReason: 'superseded-by' });
  });
});

describe('a failed hook, projected (COR-2097)', () => {
  const failed = (detail: Record<string, unknown>) =>
    projectBureauEvent(
      new HookPlanFailedRecordedEvent(recorded('run-1', 'hook-plan.failed', detail)),
    );

  it('publishes the registration, the hook point, the registrant and an error code, never the error', () => {
    const projected = failed({
      hookName: 'prepareStep',
      hookId: 'plugin:audit:guard',
      source: 'audit',
      durationMilliseconds: 12,
      error: Object.assign(new Error(CANARY), { code: 'HOOK_REFUSED', cause: CANARY }),
    });

    expect(projected).toEqual({
      kind: 'hook-plan.failed',
      payload: {
        runId: 'run-1',
        hookId: 'plugin:audit:guard',
        hookName: 'prepareStep',
        source: 'audit',
        errorCode: 'HOOK_REFUSED',
      },
    });
    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });

  it('omits a registrant that is not one token and names a hook that is not one UNKNOWN', () => {
    const projected = failed({
      hookName: `on step ${CANARY}`,
      hookId: `an id with ${CANARY}`,
      source: `a registrant ${CANARY}`,
      error: new Error('x'),
    });

    expect(projected?.payload).toEqual({
      runId: 'run-1',
      hookId: 'UNKNOWN',
      hookName: 'UNKNOWN',
      errorCode: 'INTERNAL_ERROR',
    });
    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });

  it.each([
    ['a code with spaces', { code: `failed ${CANARY}` }],
    ['a lower-case code', { code: 'failed' }],
    ['a thrown string', CANARY],
    ['nothing', undefined],
  ])('publishes INTERNAL_ERROR for an error that is %s', (_name, error) => {
    expect(failed({ hookName: 'onStep', hookId: 'h', error })?.payload['errorCode']).toBe(
      'INTERNAL_ERROR',
    );
  });
});

describe('a workflow version mismatch, projected (COR-2097)', () => {
  it('publishes the workflow and the two versions', () => {
    const projected = projectBureauEvent(
      new WorkflowVersionMismatchEvent('wf-1', '1.4.0', '2.0.0'),
    );

    expect(projected).toEqual({
      kind: 'workflow.version-mismatch',
      payload: { workflowId: 'wf-1', storedVersion: '1.4.0', registeredVersion: '2.0.0' },
    });
  });

  it('does not publish a version that is more than one token', () => {
    const projected = projectBureauEvent(
      new WorkflowVersionMismatchEvent('wf-1', `released by ${CANARY} on friday`, '2.0.0'),
    );

    expect(projected?.payload).toEqual({
      workflowId: 'wf-1',
      storedVersion: 'UNKNOWN',
      registeredVersion: '2.0.0',
    });
    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });
});
