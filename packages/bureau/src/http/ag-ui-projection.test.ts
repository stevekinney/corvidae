/**
 * COR-855 — the projector that turns one native run's events into AG-UI events,
 * with no server and no run: recorded events and live text deltas go in, events
 * come out.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';

import { errorOf, RECORDED, RunProjector } from './ag-ui-projection.ts';
import { pluginToolCallName } from './ag-ui-vocabulary.ts';

const RUN = 'run-1';

function projector() {
  return new RunProjector(RUN, { nativeRunId: RUN, sessionId: 'thread-1', now: () => 1 });
}

const types = (events: ReadonlyArray<{ type: string }>) => events.map((event) => event.type);

describe('text', () => {
  it('opens a message on the first delta, streams the rest, and ends it with the text the guardrails left', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const first = run.handleTextDelta('Hel', 'Hel');
    const second = run.handleTextDelta('lo', 'Hello');
    const done = run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: { content: 'Hello!' },
    });

    expect(types(first.events)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(first.events[0]).toMatchObject({ messageId: 'run-1:step:0', role: 'assistant' });
    expect(first.events[1]).toMatchObject({ delta: 'Hel' });
    expect(second.events).toMatchObject([{ delta: 'lo' }]);
    expect(done.events).toMatchObject([
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '!' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'run-1:step:0' },
    ]);
  });

  it('gives a stream that attaches mid-message the text accumulated so far in its first content event', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 2 });

    const late = run.handleTextDelta('rld', 'Hello world');

    expect(late.events).toMatchObject([
      { type: EventType.TEXT_MESSAGE_START, messageId: 'run-1:step:2' },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'Hello world' },
    ]);
  });

  it('sends a whole message when no delta announced one, and never a second for the same step', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });
    const detail = { step: 0, response: { content: 'All at once.' } };

    const once = run.handleRecorded(RECORDED.generateCompleted, detail);
    const again = run.handleRecorded(RECORDED.generateCompleted, detail);

    expect(types(once.events)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(again.events).toEqual([]);
  });

  it('ignores a delta that arrives with no step in flight', () => {
    expect(projector().handleTextDelta('x', 'x').events).toEqual([]);
  });
});

describe('tools', () => {
  const call = { id: 'call-1', name: 'lookup', arguments: { q: 'x' } };
  const result = {
    callId: 'call-1',
    toolCallId: 'call-1',
    outcome: 'success',
    content: { found: 'x' },
  };

  it('announces a call and its result once, however many events carry them', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const executing = run.handleRecorded(RECORDED.toolsExecuting, { step: 0, toolCalls: [call] });
    const executed = run.handleRecorded(RECORDED.toolsExecuted, {
      step: 0,
      toolCalls: [call],
      results: [result],
    });
    const completed = run.handleRecorded(RECORDED.stepCompleted, {
      step: 0,
      content: '',
      toolCalls: [call],
      results: [result],
    });

    expect(types(executing.events)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
    expect(executing.events[0]).toMatchObject({
      toolCallId: 'call-1',
      parentMessageId: 'run-1:step:0',
    });
    expect(types(executed.events)).toEqual([EventType.TOOL_CALL_RESULT]);
    expect(executed.events[0]).toMatchObject({
      messageId: 'run-1:step:0:result:call-1',
      content: '{"found":"x"}',
    });
    expect(types(completed.events)).toEqual([EventType.STEP_FINISHED]);
  });

  it('still tells a client about a call that only the step’s last word carries', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const completed = run.handleRecorded(RECORDED.stepCompleted, {
      step: 0,
      content: '',
      toolCalls: [call],
      results: [result],
    });

    expect(types(completed.events)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.STEP_FINISHED,
    ]);
  });

  it('names a plugin tool p:t whether a call or only a result announces it (COR-1879)', () => {
    const toolCallName = pluginToolCallName(() => new Set(['p']));
    const live = new RunProjector(RUN, { nativeRunId: RUN, now: () => 1, toolCallName });
    live.handleRecorded(RECORDED.stepStarted, { step: 0 });
    const announced = live.handleRecorded(RECORDED.toolsExecuting, {
      step: 0,
      toolCalls: [
        { id: 'call-1', name: 'p__t', arguments: {} },
        // A tool source's tool, with no plugin of that name running, keeps its own name.
        { id: 'call-2', name: 'source__t', arguments: {} },
      ],
    });
    const late = new RunProjector(RUN, { nativeRunId: RUN, now: () => 1, toolCallName });
    late.handleRecorded(RECORDED.stepStarted, { step: 0 });
    const completed = late.handleRecorded(RECORDED.stepCompleted, {
      step: 0,
      content: '',
      toolCalls: [],
      results: [{ ...result, toolName: 'p:t' }],
    });

    expect(announced.events[0]).toMatchObject({ toolCallName: 'p:t' });
    expect(announced.events[3]).toMatchObject({ toolCallName: 'source__t' });
    expect(completed.events[0]).toMatchObject({ toolCallName: 'p:t' });
  });
});

describe('the answer an onMaximumSteps handler leaves', () => {
  const steps = [
    { step: 0, content: '' },
    { step: 1, content: 'Still working.' },
  ];
  const completed = (overrides: Record<string, unknown>) => ({
    finishReason: 'maximum-steps',
    content: 'Out of steps.',
    steps,
    ...overrides,
  });

  it('is announced with the run’s completion, under the id of the step after the last', () => {
    const run = projector();

    const ended = run.handleRecorded(RECORDED.runCompleted, completed({}));

    expect(ended.events).toMatchObject([
      { type: EventType.TEXT_MESSAGE_START, messageId: 'run-1:step:2', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'run-1:step:2', delta: 'Out of steps.' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'run-1:step:2' },
    ]);
    // COR-1627: a step-limit run is a failure, so the AG-UI run ends in the error this record carries.
    expect(ended.terminal).toMatchObject({ outcome: 'error', recordedAs: RECORDED.runCompleted });
  });

  it('is not announced to a client whose snapshot already holds the row', () => {
    const run = projector();
    run.holds(['user-1', 'run-1:step:2']);

    expect(run.handleRecorded(RECORDED.runCompleted, completed({})).events).toEqual([]);
  });

  it('is announced once, however often the completion is projected', () => {
    const run = projector();

    run.handleRecorded(RECORDED.runCompleted, completed({}));

    expect(run.handleRecorded(RECORDED.runCompleted, completed({})).events).toEqual([]);
  });

  it.each([
    [
      'a run that ended with no handler, whose text is its last step’s',
      { content: 'Still working.' },
    ],
    ['a handler that left no text', { content: '' }],
    ['a run that stopped on a condition', { finishReason: 'stop-condition' }],
    ['a completion with no text to read', { content: undefined }],
    [
      'a completion whose steps could not be read, which cannot say where the row goes',
      { steps: [] },
    ],
  ])('is not invented for %s', (_name, overrides) => {
    expect(projector().handleRecorded(RECORDED.runCompleted, completed(overrides)).events).toEqual(
      [],
    );
  });
});

describe('a run that stopped at its step limit (COR-1627)', () => {
  /** What Bureau records for the `run.error` a step-limit run announces: the error, serialized. */
  const stepLimitError = {
    step: 2,
    error: JSON.stringify({
      name: 'MaximumStepsExceededError',
      message: 'Agent run exceeded maximumSteps (2).',
      kind: 'policy',
      code: 'MAXIMUM_STEPS',
    }),
  };

  it('does not end on the run.error, which projects nothing', () => {
    expect(
      projector().handleRecorded(RECORDED.runError, {
        ...stepLimitError,
        finishReason: 'maximum-steps',
      }),
    ).toEqual({ events: [] });
  });

  it('ends in the error on the run.completed that follows, after the handler’s row', () => {
    const run = projector();
    run.handleRecorded(RECORDED.runError, { ...stepLimitError, finishReason: 'maximum-steps' });

    const ended = run.handleRecorded(RECORDED.runCompleted, {
      finishReason: 'maximum-steps',
      content: 'Out of steps.',
      steps: [{ step: 0, content: '' }],
      error: stepLimitError.error,
    });

    expect(types(ended.events)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(ended.terminal).toMatchObject({ outcome: 'error', recordedAs: RECORDED.runCompleted });
    expect(errorOf(ended.terminal?.detail)).toEqual({
      code: 'MAXIMUM_STEPS',
      message: 'Agent run exceeded maximumSteps (2).',
    });
  });

  it('ends on a run.error that carries the step-limit code but no finish reason', () => {
    // A record from before the payload carried a finish reason: `main` never recorded a
    // `run.error` for a run that ran out of steps, so such a record is a thrown error, which
    // `main` ended the stream on, and the `run.completed` that follows it says `error` too.
    const ended = projector().handleRecorded(RECORDED.runError, stepLimitError);

    expect(ended.terminal).toMatchObject({ outcome: 'error' });
    expect(errorOf(ended.terminal?.detail)).toMatchObject({ code: 'MAXIMUM_STEPS' });
  });

  it('ends on a run.error that carries the step-limit code but finished as a plain error', () => {
    // A thrown `AgentRunError` with the code `MAXIMUM_STEPS` is not a step limit: the run
    // classifies it as `error`, and no `run.completed` of `maximum-steps` follows to end it.
    const ended = projector().handleRecorded(RECORDED.runError, {
      ...stepLimitError,
      finishReason: 'error',
    });

    expect(ended.terminal).toMatchObject({ outcome: 'error' });
    expect(errorOf(ended.terminal?.detail)).toMatchObject({ code: 'MAXIMUM_STEPS' });
  });

  it('still ends on any other run.error', () => {
    const ended = projector().handleRecorded(RECORDED.runError, {
      error: JSON.stringify({ message: 'boom', code: 'UNKNOWN' }),
    });

    expect(ended.terminal).toMatchObject({ outcome: 'error' });
    expect(ended.terminal?.recordedAs).toBeUndefined();
  });
});

describe('the run.completed of a run that failed (COR-1627)', () => {
  // Every failure records `run.error` and then the `run.completed` that carries its finish
  // reason. A replay that reads to the last terminal, or a history read that keeps the last one,
  // must still end in the error: the completion of a failed run is not a success.
  it.each(['error', 'tripwire', 'elicitation-denied', 'budget-exceeded', 'maximum-steps'])(
    'ends in the error for finishReason %s',
    (finishReason) => {
      const ended = projector().handleRecorded(RECORDED.runCompleted, {
        finishReason,
        content: '',
        steps: [],
        error: JSON.stringify({ message: 'it failed', code: 'UNKNOWN' }),
      });

      expect(ended.terminal).toMatchObject({
        outcome: 'error',
        recordedAs: RECORDED.runCompleted,
      });
      expect(errorOf(ended.terminal?.detail)).toEqual({ code: 'UNKNOWN', message: 'it failed' });
    },
  );

  it('ends in a success for a stop condition', () => {
    const ended = projector().handleRecorded(RECORDED.runCompleted, {
      finishReason: 'stop-condition',
      content: 'Done.',
      steps: [],
    });

    expect(ended.terminal).toMatchObject({ outcome: 'completed' });
    expect(ended.terminal?.recordedAs).toBeUndefined();
  });
});

describe('ending', () => {
  it('closes a message and a step an interrupted run leaves open, and only those', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });
    run.handleTextDelta('Hi', 'Hi');

    const closing = run.closeOpen();
    const again = run.closeOpen();

    expect(closing).toMatchObject([
      { type: EventType.TEXT_MESSAGE_END, messageId: 'run-1:step:0' },
      { type: EventType.STEP_FINISHED, stepName: 'step-0' },
    ]);
    expect(again).toEqual([]);
  });

  it('reports the terminal fact and the tripwire that preceded it', () => {
    const run = projector();
    run.handleRecorded(RECORDED.runTripwire, {});

    const ended = run.handleRecorded(RECORDED.runError, { error: 'x' });

    expect(ended.terminal).toMatchObject({ outcome: 'error', tripwire: true });
  });

  it('flags a human-wait park for the driver to check against the pending reviews', () => {
    expect(projector().handleRecorded(RECORDED.humanWaitParked, {}).parked).toBe(true);
  });

  it('projects every kind of event it knows to a member of the small set it emits', () => {
    const run = projector();
    const emitted = [
      run.handleRecorded(RECORDED.stepStarted, { step: 0 }),
      run.handleTextDelta('a', 'a'),
      run.handleRecorded(RECORDED.generateCompleted, { step: 0, response: { content: 'a' } }),
      run.handleRecorded(RECORDED.toolsExecuting, {
        step: 0,
        toolCalls: [{ id: 'c', name: 'n', arguments: {} }],
      }),
      run.handleRecorded('hook-plan.registered', {}),
      run.handleRecorded('usage.accumulated', {}),
      run.handleRecorded(RECORDED.stepCompleted, { step: 0, content: 'a' }),
    ].flatMap((projection) => projection.events);

    const allowed = new Set<string>([
      EventType.STEP_STARTED,
      EventType.STEP_FINISHED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
    expect(emitted.every((event) => allowed.has(event.type))).toBe(true);
  });
});
