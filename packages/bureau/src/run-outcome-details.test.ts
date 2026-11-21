import {
  type ActiveRun,
  AgentRunError,
  createAgentRunEventRegistry,
  GenerateCompletedEvent,
  GenerateErrorEvent,
  GenerateRetryEvent,
  GenerateStartedEvent,
  RunErrorEvent,
  ToolSettledBubbleEvent,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { attachRunEventFeed } from './run-event-feed-attachment';
import { createRunOutcomeDetails, peekTaskFailure } from './run-outcome-details';

/** A run that is only an event target, which is all the attachment reads. */
function fakeRun(): {
  readonly run: Pick<ActiveRun, 'addEventListener' | 'removeEventListener'>;
  readonly dispatch: (event: Event) => void;
} {
  const target = new EventTarget();
  return {
    run: target as unknown as Pick<ActiveRun, 'addEventListener' | 'removeEventListener'>,
    dispatch: (event) => {
      target.dispatchEvent(event);
    },
  };
}

const PROVIDER_FAILURE = new AgentRunError('the provider failed', {
  kind: 'generate',
  code: 'UNKNOWN',
});

const TOOL_FAILURE = new AgentRunError('the tool failed', { kind: 'tool', code: 'UNKNOWN' });

describe('run outcome details (COR-2095)', () => {
  it('hands an entry over once: take removes it', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', { step: 2, error: { code: 'E_CODE', kind: 'generate' } });

    expect(details.size()).toBe(1);
    expect(details.take('run-1')).toEqual({
      step: 2,
      errorCode: 'E_CODE',
      errorKind: 'generate',
      stepLabel: 'model',
    });
    expect(details.take('run-1')).toBeUndefined();
    expect(details.size()).toBe(0);
  });

  it('peeks an entry without removing it', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', { step: 2, error: { code: 'E_CODE', kind: 'generate' } });

    expect(details.peek('run-1')).toEqual(details.peek('run-1'));
    expect(details.size()).toBe(1);
    expect(peekTaskFailure(details, 'run-1')).toEqual({
      step: { index: 2, label: 'model' },
      errorCode: 'E_CODE',
      errorKind: 'generate',
    });
    expect(details.take('run-1')).toBeDefined();
    expect(peekTaskFailure(details, 'run-1')).toBeUndefined();
  });

  it('labels a step by the failed tool, or `model` for a model or output failure, and by nothing otherwise', () => {
    const details = createRunOutcomeDetails();
    details.record('tool', {
      step: 1,
      error: { code: 'E_CODE', kind: 'tool' },
      toolCall: { name: 'charge-card', callId: 'call-1' },
    });
    details.record('tool-without-call', { step: 1, error: { code: 'E_CODE', kind: 'tool' } });
    details.record('output', { step: 1, error: { code: 'E_CODE', kind: 'output' } });
    details.record('policy', { step: 1, error: { code: 'E_CODE', kind: 'policy' } });

    expect(peekTaskFailure(details, 'tool')).toEqual({
      step: { index: 1, label: 'charge-card' },
      errorCode: 'E_CODE',
      errorKind: 'tool',
      toolCall: { name: 'charge-card', callId: 'call-1' },
    });
    expect(peekTaskFailure(details, 'tool-without-call')?.step).toBeUndefined();
    expect(peekTaskFailure(details, 'output')?.step).toEqual({ index: 1, label: 'model' });
    expect(peekTaskFailure(details, 'policy')?.step).toBeUndefined();
  });

  it('cuts a tool name and a call identifier to the length a failure keeps', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', {
      step: 0,
      error: { code: 'E_CODE', kind: 'tool' },
      toolCall: { name: 'n'.repeat(500), callId: 'c'.repeat(500) },
    });

    const failure = peekTaskFailure(details, 'run-1');
    expect(failure?.toolCall?.name).toHaveLength(200);
    expect(failure?.toolCall?.callId).toHaveLength(200);
    expect(failure?.step?.label).toHaveLength(200);
  });

  it('omits the step of a reconstructed RunErrorEvent, whose step is a count and not the failing step', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', {
      step: 7,
      error: { code: 'E_CODE', kind: 'generate' },
      reconstructed: true,
    });

    const entry = details.take('run-1');
    expect(entry).toEqual({ errorCode: 'E_CODE', errorKind: 'generate' });
    expect(entry).not.toHaveProperty('step');
  });

  it('keeps a code only when it is an identifier and a kind only when it is a known one', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', {
      step: 1,
      error: { code: 'rate limited, call 555-0100', kind: 'free text' },
    });
    details.record('run-2', { step: 1, error: { code: 'a'.repeat(10), kind: 'policy' } });
    details.record('run-3', { step: 1, error: { code: 'A'.repeat(65), kind: 'policy' } });

    expect(details.take('run-1')).toEqual({ step: 1, errorCode: 'UNKNOWN' });
    expect(details.take('run-2')).toEqual({ step: 1, errorCode: 'UNKNOWN', errorKind: 'policy' });
    expect(details.take('run-3')).toEqual({ step: 1, errorCode: 'UNKNOWN', errorKind: 'policy' });
  });

  it('forgets one run and clears every run', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', { step: 0, error: { code: 'E_CODE', kind: 'generate' } });
    details.record('run-2', { step: 0, error: { code: 'E_CODE', kind: 'generate' } });

    details.forget('run-1');
    expect(details.size()).toBe(1);
    details.clear();
    expect(details.size()).toBe(0);
  });
});

describe('attachRunEventFeed and the outcome details (COR-2095)', () => {
  it('records the live RunErrorEvent under the run, with its step, code and kind', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    dispatch(new RunErrorEvent(3, PROVIDER_FAILURE));

    expect(details.take('run-1')).toEqual({
      step: 3,
      errorCode: PROVIDER_FAILURE.code,
      errorKind: PROVIDER_FAILURE.kind,
      stepLabel: 'model',
    });
  });

  it('names the tool call that settled in error in the step the run failed in, never its arguments', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });
    const stamp = { agentName: 'default', runId: 'run-1', step: 2 };

    // A call that succeeded, one in another step, and two that failed in this one: the failure
    // names the call whose error the run's own error carries, not the first or the last.
    const earlier = new Error('earlier ARGUMENT-MARKER');
    const charge = new Error('charge ARGUMENT-MARKER');
    const sibling = new Error('sibling ARGUMENT-MARKER');
    dispatch(
      new ToolSettledBubbleEvent(stamp, { toolName: 'lookup', toolCallId: 'a', status: 'success' }),
    );
    dispatch(
      new ToolSettledBubbleEvent(
        { ...stamp, step: 1 },
        { toolName: 'earlier', toolCallId: 'b', status: 'error', error: earlier },
      ),
    );
    dispatch(
      new ToolSettledBubbleEvent(stamp, {
        toolName: 'charge-card',
        toolCallId: 'c',
        status: 'error',
        error: charge,
      }),
    );
    dispatch(
      new ToolSettledBubbleEvent(stamp, {
        toolName: 'sibling',
        toolCallId: 'd',
        status: 'error',
        error: sibling,
      }),
    );
    dispatch(
      new RunErrorEvent(
        2,
        new AgentRunError('x', { kind: 'tool', code: 'UNKNOWN', cause: sibling }),
      ),
    );

    const entry = details.take('run-1');
    expect(entry?.toolCall).toEqual({ name: 'sibling', callId: 'd' });
    expect(entry?.stepLabel).toBe('sibling');
    expect(JSON.stringify(entry)).not.toContain('ARGUMENT-MARKER');

    // The error the toolbox rejected with is the run error's cause, however deep it is wrapped.
    dispatch(
      new RunErrorEvent(
        2,
        new AgentRunError('outer', {
          kind: 'tool',
          code: 'UNKNOWN',
          cause: new AgentRunError('inner', { kind: 'tool', code: 'UNKNOWN', cause: charge }),
        }),
      ),
    );
    expect(details.take('run-1')?.toolCall).toEqual({ name: 'charge-card', callId: 'c' });
  });

  it('names no call for a terminal error of the same step that no failed call’s error caused', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });
    const stamp = { agentName: 'default', runId: 'run-1', step: 2 };
    // A call fails recoverably (the default collect mode hands its error back to the model), and a
    // later call's result trips a guardrail: the policy error ends the run, and is not the call's.
    dispatch(
      new ToolSettledBubbleEvent(stamp, {
        toolName: 'flaky',
        toolCallId: 'a',
        status: 'error',
        error: new Error('recoverable'),
      }),
    );
    dispatch(
      new ToolSettledBubbleEvent(stamp, { toolName: 'fetch', toolCallId: 'b', status: 'success' }),
    );

    dispatch(
      new RunErrorEvent(
        2,
        new AgentRunError('tripwire', { kind: 'policy', code: 'TRIPWIRE' }),
        'policy',
      ),
    );

    const entry = details.take('run-1');
    expect(entry).not.toHaveProperty('toolCall');
    expect(entry).not.toHaveProperty('stepLabel');
  });

  it('names no call for a failure in a step where no call settled in error', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    const cause = new Error('earlier step');
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });
    dispatch(
      new ToolSettledBubbleEvent(
        { agentName: 'default', runId: 'run-1', step: 1 },
        { toolName: 'charge-card', toolCallId: 'c', status: 'error', error: cause },
      ),
    );

    dispatch(
      new RunErrorEvent(2, new AgentRunError('x', { kind: 'tool', code: 'UNKNOWN', cause })),
    );

    expect(details.take('run-1')).not.toHaveProperty('toolCall');
  });

  it('reports a model step on its second or later try, and clears it when the step settles or fails', () => {
    const changes: Array<[string, unknown]> = [];
    const details = createRunOutcomeDetails({
      onRetrying: (runId, retrying) => changes.push([runId, retrying]),
    });
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    // The event names the attempt that failed: attempt 1 failed, so attempt 2 is starting.
    dispatch(new GenerateRetryEvent(0, 1, new Error('rate limited')));
    dispatch(new GenerateRetryEvent(0, 2, new Error('rate limited')));
    dispatch(new GenerateErrorEvent(0, new Error('rate limited'), 5));
    // Nothing is retrying, so nothing more is reported for a second ending.
    dispatch(new GenerateErrorEvent(0, new Error('rate limited'), 5));

    expect(changes).toEqual([
      ['run-1', { label: 'model', attempt: 2 }],
      ['run-1', { label: 'model', attempt: 3 }],
      ['run-1', null],
    ]);
  });

  it('counts the error hook’s re-runs of a step with the provider’s retries, and clears when another step starts', () => {
    const changes: unknown[] = [];
    const details = createRunOutcomeDetails({
      onRetrying: (_runId, change) => changes.push(change),
    });
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    dispatch(new GenerateStartedEvent(0));
    // The step fails, and the error hook asks for it to run again: the same step starts again.
    dispatch(new GenerateErrorEvent(0, new Error('overloaded'), 5));
    dispatch(new GenerateStartedEvent(0));
    // It fails again and is run a third time; the failure between the runs clears the retry.
    dispatch(new GenerateErrorEvent(0, new Error('overloaded'), 5));
    dispatch(new GenerateStartedEvent(0));
    // The third run retries a provider call too: the fourth try overall.
    dispatch(new GenerateRetryEvent(0, 1, new Error('overloaded')));
    dispatch(new GenerateCompletedEvent(0, { content: 'done', toolCalls: [] }, 5));
    // The next step starts: nothing is retrying.
    dispatch(new GenerateStartedEvent(1));

    expect(changes).toEqual([
      { label: 'model', attempt: 2 },
      null,
      { label: 'model', attempt: 3 },
      { label: 'model', attempt: 4 },
      null,
    ]);
  });

  it('ignores a tool call that another run settled on this run’s emitter', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    const cause = new Error('the child’s tool failed');
    dispatch(
      new ToolSettledBubbleEvent(
        { agentName: 'child', runId: 'child-run', step: 2 },
        { toolName: 'child-tool', toolCallId: 'x', status: 'error', error: cause },
      ),
    );
    dispatch(
      new RunErrorEvent(2, new AgentRunError('x', { kind: 'tool', code: 'UNKNOWN', cause })),
    );

    expect(details.take('run-1')).not.toHaveProperty('toolCall');
  });

  it('keeps the provider tries across a whole-step re-run, so the count only rises', () => {
    const changes: unknown[] = [];
    const details = createRunOutcomeDetails({
      onRetrying: (_runId, change) => changes.push(change),
    });
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    // `retry: { attempts: 3 }`: the provider is tried three times, then the error hook asks for the
    // step to run again, and its first provider call is the fourth try.
    dispatch(new GenerateStartedEvent(0));
    dispatch(new GenerateRetryEvent(0, 1, new Error('overloaded')));
    dispatch(new GenerateRetryEvent(0, 2, new Error('overloaded')));
    dispatch(new GenerateErrorEvent(0, new Error('overloaded'), 5));
    dispatch(new GenerateStartedEvent(0));

    expect(changes).toEqual([
      { label: 'model', attempt: 2 },
      { label: 'model', attempt: 3 },
      null,
      { label: 'model', attempt: 4 },
    ]);
  });

  it('does not report a retry for a step that never retried', () => {
    const changes: unknown[] = [];
    const details = createRunOutcomeDetails({
      onRetrying: (_runId, change) => changes.push(change),
    });
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    dispatch(new GenerateStartedEvent(0));
    dispatch(new GenerateRetryEvent(0, 0, new Error('bad attempt number')));

    expect(changes).toEqual([]);
  });

  it('reports a retry callback that throws, and the run’s own dispatch goes on', () => {
    const reported: Array<[unknown, string]> = [];
    const details = createRunOutcomeDetails({
      onRetrying: () => {
        throw new Error('registry down');
      },
    });
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), {
      outcomeDetails: details,
      onError: (error, kind) => reported.push([error, kind]),
    });

    expect(() => dispatch(new GenerateRetryEvent(0, 1, new Error('rate limited')))).not.toThrow();
    expect(reported.map(([, kind]) => kind)).toContain('generate.retry');
  });

  it('records a reconstructed RunErrorEvent without its step (a reattached run)', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    dispatch(new RunErrorEvent(9, PROVIDER_FAILURE, undefined, { reconstructed: true }));

    const entry = details.take('run-1');
    expect(entry).toMatchObject({
      errorCode: PROVIDER_FAILURE.code,
      errorKind: PROVIDER_FAILURE.kind,
    });
    expect(entry).not.toHaveProperty('step');
  });

  it('reports a recorder that throws, and the run’s own dispatch goes on', () => {
    const reported: Array<[unknown, string]> = [];
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), {
      outcomeDetails: {
        record() {
          throw new Error('recorder down');
        },
        recordRetrying() {},
      },
      onError: (error, kind) => reported.push([error, kind]),
    });

    expect(() => dispatch(new RunErrorEvent(0, PROVIDER_FAILURE))).not.toThrow();
    expect(reported.map(([, kind]) => kind)).toContain('run.error');
  });

  it('stops recording once the run is detached', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    const detach = attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), {
      outcomeDetails: details,
    });

    detach();
    dispatch(new RunErrorEvent(0, PROVIDER_FAILURE));

    expect(details.size()).toBe(0);
  });

  it('records nothing for a run attached with no details, as before', () => {
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry());

    expect(() => dispatch(new RunErrorEvent(0, PROVIDER_FAILURE))).not.toThrow();
  });
});
