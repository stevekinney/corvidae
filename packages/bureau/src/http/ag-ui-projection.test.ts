/**
 * COR-855 — the projector that turns one native run's events into AG-UI events,
 * with no server and no run: recorded events and live text deltas go in, events
 * come out.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';

import { RECORDED, RunProjector } from './ag-ui-projection.ts';

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
    expect(ended.terminal).toMatchObject({ outcome: 'completed' });
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
