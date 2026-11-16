import {
  type ActiveRun,
  AgentRunError,
  BudgetThresholdEvent,
  RunErrorEvent,
  RunGuardrailEvent,
  RunTripwireEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import {
  BudgetThresholdRecordedEvent,
  RunGuardrailRecordedEvent,
  RunTripwireRecordedEvent,
  ToolErrorRecordedEvent,
  ToolPolicyDeniedRecordedEvent,
} from './events';
import {
  RECORDED_RUN_EVENT_TYPES,
  type RecordedRunEvent,
  observeRecordedRunEvents,
  recordedRunEvent,
} from './recorded-run-events';
import { createRunOutcomeDetails } from './run-outcome-details';

describe('recordedRunEvent (COR-2096)', () => {
  it.each([
    ['run.tripwire', RunTripwireRecordedEvent],
    ['run.guardrail', RunGuardrailRecordedEvent],
    ['budget.threshold', BudgetThresholdRecordedEvent],
    ['tool.policy-denied', ToolPolicyDeniedRecordedEvent],
    ['tool.error', ToolErrorRecordedEvent],
  ] as const)('wraps a recorded %s action in its Bureau event', (type, event) => {
    const action = { sequence: 1, runId: 'run-1', type, detail: null, timestamp: 1 };

    const wrapped = recordedRunEvent(action);

    expect(wrapped).toBeInstanceOf(event);
    expect(wrapped?.type).toBe(type);
    expect(wrapped?.action).toBe(action);
  });

  it('wraps no other action', () => {
    for (const type of ['action', 'run.completed', 'run.error', 'step.completed', 'tool.started']) {
      expect(
        recordedRunEvent({ sequence: 1, runId: 'run-1', type, detail: null, timestamp: 1 }),
      ).toBeUndefined();
    }
  });

  it('names exactly the five types', () => {
    expect([...RECORDED_RUN_EVENT_TYPES]).toEqual([
      'run.tripwire',
      'run.guardrail',
      'budget.threshold',
      'tool.policy-denied',
      'tool.error',
    ]);
  });
});

describe('observeRecordedRunEvents (COR-2096)', () => {
  function fakeRun(runId = 'attempt-1') {
    const target = new EventTarget();
    return {
      run: Object.assign(target, { runId }) as unknown as Pick<
        ActiveRun,
        'addEventListener' | 'removeEventListener' | 'runId'
      >,
      fire: (event: Event) => target.dispatchEvent(event),
    };
  }

  it('builds the action the store would, from the event’s own fields, and counts the run’s events', () => {
    const { run, fire } = fakeRun();
    const seen: RecordedRunEvent[] = [];
    observeRecordedRunEvents(run, { dispatch: (event) => seen.push(event), now: () => 1234 });

    fire(
      new RunTripwireEvent(0, {
        guardrailName: 'sentinel',
        category: 'pii',
        phase: 'input',
        confidence: 1,
        detail: 'quotes the text',
      }),
    );
    fire(
      new RunGuardrailEvent(1, {
        guardrailName: 'sentinel',
        category: 'pii',
        phase: 'output',
        confidence: 0.5,
        action: 'redact',
      }),
    );
    fire(
      new BudgetThresholdEvent(
        { threshold: 0.5, currentCost: 0.1, budget: 0.15, model: 'cheap' },
        2,
      ),
    );
    fire(
      new ToolPolicyDeniedBubbleEvent(
        { agentName: 'worker', runId: 'attempt-1', step: 3 },
        { toolName: 'refund', toolCallId: 'call-1', reason: 'no' },
      ),
    );
    fire(
      new ToolErrorBubbleEvent(
        { agentName: 'worker', runId: 'attempt-1', step: 4 },
        { toolName: 'refund', toolCallId: 'call-2', error: new Error('x') },
      ),
    );

    expect(seen.map((event) => [event.type, event.action.sequence, event.action.runId])).toEqual([
      ['run.tripwire', 0, 'attempt-1'],
      ['run.guardrail', 1, 'attempt-1'],
      ['budget.threshold', 2, 'attempt-1'],
      ['tool.policy-denied', 3, 'attempt-1'],
      ['tool.error', 4, 'attempt-1'],
    ]);
    expect(seen[0]?.action).toMatchObject({
      timestamp: 1234,
      detail: { step: 0, guardrailName: 'sentinel', phase: 'input' },
    });
  });

  it('records the live run.error for the outcome event that follows', () => {
    const { run, fire } = fakeRun();
    const outcomeDetails = createRunOutcomeDetails();
    observeRecordedRunEvents(run, { dispatch: () => undefined, now: () => 1, outcomeDetails });

    fire(new RunErrorEvent(2, new AgentRunError('boom', { kind: 'generate', code: 'UNKNOWN' })));

    expect(outcomeDetails.take('attempt-1')).toEqual({
      step: 2,
      errorCode: 'UNKNOWN',
      errorKind: 'generate',
    });
  });

  it('reports a dispatch that throws, and the run’s own dispatch goes on', () => {
    const { run, fire } = fakeRun();
    const reported: string[] = [];
    observeRecordedRunEvents(run, {
      dispatch: () => {
        throw new Error('feed down');
      },
      now: () => 1,
      onError: (_error, kind) => reported.push(kind),
    });

    expect(() =>
      fire(
        new ToolErrorBubbleEvent(
          { agentName: 'worker', runId: 'attempt-1', step: 0 },
          { toolName: 'refund', toolCallId: 'call-1', error: undefined },
        ),
      ),
    ).not.toThrow();
    expect(reported).toEqual(['tool.error']);
  });

  it('stops observing once detached', () => {
    const { run, fire } = fakeRun();
    const seen: RecordedRunEvent[] = [];
    const detach = observeRecordedRunEvents(run, {
      dispatch: (event) => seen.push(event),
      now: () => 1,
    });

    detach();
    fire(
      new ToolErrorBubbleEvent(
        { agentName: 'worker', runId: 'attempt-1', step: 0 },
        { toolName: 'refund', toolCallId: 'call-1', error: undefined },
      ),
    );

    expect(seen).toEqual([]);
  });
});
