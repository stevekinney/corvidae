/**
 * COR-1806 — the projector's reasoning and announcement frames, with no server and no run:
 * recorded events go in, AG-UI events come out.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';

import { RECORDED, RunProjector } from './ag-ui-projection.ts';
import { isReasoningEvent } from './ag-ui-vocabulary.ts';

const RUN = 'run-1';

function projector() {
  return new RunProjector(RUN, { nativeRunId: RUN, sessionId: 'thread-1', now: () => 1 });
}

const types = (events: ReadonlyArray<{ type: string }>) => events.map((event) => event.type);

describe('reasoning', () => {
  it('announces each thinking part as a message of one span, before the step’s text', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const done = run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: {
        content: 'The answer.',
        parts: [
          { type: 'thinking', thinking: 'first thought', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'thinking', thinking: 'second thought', signature: 'sig-2' },
          { type: 'text', text: 'The answer.' },
        ],
      },
    });

    expect(types(done.events)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(done.events[0]).toMatchObject({ messageId: 'run-1:step:0:reasoning' });
    expect(done.events[1]).toMatchObject({
      messageId: 'run-1:step:0:reasoning:0',
      role: 'reasoning',
    });
    expect(done.events[2]).toMatchObject({ delta: 'first thought' });
    expect(done.events[5]).toMatchObject({
      messageId: 'run-1:step:0:reasoning:1',
      delta: 'second thought',
    });
    expect(done.events[7]).toMatchObject({ messageId: 'run-1:step:0:reasoning' });
    const wire = JSON.stringify(done.events);
    expect(wire).not.toContain('sig-1');
    expect(wire).not.toContain('opaque');
    expect(done.events.filter(isReasoningEvent)).toHaveLength(8);
  });

  it('sends a step’s reasoning once, however many times its generate.completed is read', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });
    const detail = {
      step: 0,
      response: { content: '', parts: [{ type: 'thinking', thinking: 'hm', signature: 's' }] },
    };

    const once = run.handleRecorded(RECORDED.generateCompleted, detail);
    const again = run.handleRecorded(RECORDED.generateCompleted, detail);

    expect(once.events.filter(isReasoningEvent)).toHaveLength(5);
    expect(again.events).toEqual([]);
  });

  it('sends nothing for a response with no thinking, or one that no step is in flight for', () => {
    const run = projector();
    expect(
      run.handleRecorded(RECORDED.generateCompleted, {
        step: 0,
        response: { content: '', parts: [{ type: 'thinking', thinking: 'early', signature: 's' }] },
      }).events,
    ).toEqual([]);
    run.handleRecorded(RECORDED.stepStarted, { step: 1 });
    const plain = run.handleRecorded(RECORDED.generateCompleted, {
      step: 1,
      response: { content: 'Plain.', parts: [{ type: 'text', text: 'Plain.' }] },
    });
    expect(plain.events.filter(isReasoningEvent)).toEqual([]);
  });

  it('sends no frame for a thinking part the output guardrail withheld, and the others as usual', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const done = run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: {} }],
        parts: [
          { type: 'thinking', thinking: 'flagged thought', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'thinking', thinking: 'clean thought', signature: 'sig-2' },
        ],
        withheldThinking: [0],
      },
    });

    const reasoning = done.events.filter(isReasoningEvent);
    expect(types(reasoning)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
    ]);
    expect(reasoning[2]).toMatchObject({ delta: 'clean thought' });
    expect(JSON.stringify(done.events)).not.toContain('flagged thought');
  });

  it('sends no reasoning span at all when every thinking part was withheld', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const done = run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: {
        content: '',
        parts: [
          { type: 'thinking', thinking: 'flagged one', signature: 'sig-1' },
          { type: 'thinking', thinking: 'flagged two', signature: 'sig-2' },
        ],
        withheldThinking: [0, 1],
      },
    });

    expect(done.events.filter(isReasoningEvent)).toEqual([]);
    expect(JSON.stringify(done.events)).not.toContain('flagged');
  });

  it('is not part of what a late attach replays', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });
    run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: {
        content: 'Visible.',
        parts: [{ type: 'thinking', thinking: 'private', signature: 's' }],
      },
    });

    const replay = run.snapshot();

    expect(replay.filter(isReasoningEvent)).toEqual([]);
    expect(JSON.stringify(replay)).not.toContain('private');
    expect(types(replay)).toContain(EventType.TEXT_MESSAGE_CONTENT);
  });
});

describe('memory-written', () => {
  const call = { id: 'call-1', name: 'memory_store', arguments: { content: 'x' } };
  const stored = (content: unknown) => ({
    callId: 'call-1',
    toolCallId: 'call-1',
    toolName: 'memory_store',
    outcome: 'success',
    content,
  });

  function executed(content: unknown) {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 2 });
    return run.handleRecorded(RECORDED.toolsExecuted, {
      step: 2,
      toolCalls: [call],
      results: [stored(content)],
    });
  }

  it('follows the call’s result with the record, its collection and class, and the run', () => {
    const { events } = executed({
      stored: true,
      id: 'record-9',
      collection: 'assistant',
      memoryClass: 'episodic',
    });

    expect(types(events).slice(-2)).toEqual([EventType.TOOL_CALL_RESULT, EventType.CUSTOM]);
    expect(events.at(-1)).toMatchObject({
      name: 'bureau.memory-written',
      value: {
        messageId: 'run-1:step:2',
        recordId: 'record-9',
        collection: 'assistant',
        class: 'episodic',
        runId: 'run-1',
        sessionId: 'thread-1',
      },
    });
  });

  it('reads a result whose content is the JSON text of the output', () => {
    const { events } = executed(
      JSON.stringify({ stored: true, id: 'r', collection: 'c', memoryClass: 'semantic' }),
    );
    expect(events.at(-1)).toMatchObject({ value: { recordId: 'r', class: 'semantic' } });
  });

  it.each([
    ['a refused write', { stored: false }],
    ['a result that names no collection', { stored: true, id: 'r', memoryClass: 'episodic' }],
    ['a result that names no class', { stored: true, id: 'r', collection: 'c' }],
    ['a result that names no record', { stored: true, collection: 'c', memoryClass: 'episodic' }],
  ])('announces nothing for %s', (_name, content) => {
    expect(executed(content).events.every((event) => event.type !== EventType.CUSTOM)).toBe(true);
  });

  it('announces nothing for another tool, or for a failed call', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });
    const content = { stored: true, id: 'r', collection: 'c', memoryClass: 'episodic' };
    const other = run.handleRecorded(RECORDED.toolsExecuted, {
      step: 0,
      toolCalls: [{ id: 'c1', name: 'note', arguments: {} }],
      results: [{ callId: 'c1', toolCallId: 'c1', toolName: 'note', outcome: 'success', content }],
    });
    const failed = run.handleRecorded(RECORDED.toolsExecuted, {
      step: 0,
      toolCalls: [{ id: 'c2', name: 'memory_store', arguments: {} }],
      results: [
        { callId: 'c2', toolCallId: 'c2', toolName: 'memory_store', outcome: 'error', content },
      ],
    });
    expect(other.events.some((event) => event.type === EventType.CUSTOM)).toBe(false);
    expect(failed.events.some((event) => event.type === EventType.CUSTOM)).toBe(false);
  });
});

describe('wakeup-scheduled', () => {
  it('announces the run, the duration as asked, the note and when the run wakes', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const { events } = run.handleRecorded(RECORDED.wakeupScheduled, {
      duration: '6h',
      note: 'check the deploy',
      wakeAt: 21_600_000,
    });

    expect(events).toMatchObject([
      {
        type: EventType.CUSTOM,
        name: 'bureau.wakeup-scheduled',
        value: { runId: 'run-1', duration: '6h', note: 'check the deploy', wakeAt: 21_600_000 },
      },
    ]);
  });

  it('leaves the note out when there is none, and announces nothing without a wake time', () => {
    const run = projector();
    const bare = run.handleRecorded(RECORDED.wakeupScheduled, { duration: 500, wakeAt: 500 });
    expect(bare.events[0]).toMatchObject({ value: { runId: 'run-1', duration: 500, wakeAt: 500 } });
    expect(Object.keys((bare.events[0] as { value: object }).value)).not.toContain('note');
    expect(run.handleRecorded(RECORDED.wakeupScheduled, { duration: '1h' }).events).toEqual([]);
  });
});

describe('child runs', () => {
  const correlation = {
    parentAgentName: 'assistant',
    parentRunId: RUN,
    childAgentName: 'worker',
    childRunId: 'child-1',
  };

  it('announces the start without the child’s input', () => {
    const { events } = projector().handleRecorded(RECORDED.childStarted, {
      ...correlation,
      input: 'secret prompt',
      durable: true,
    });
    expect(events).toMatchObject([
      {
        type: EventType.CUSTOM,
        name: 'bureau.child-run-started',
        value: { parentRunId: RUN, childRunId: 'child-1', childAgentName: 'worker', durable: true },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('secret prompt');
  });

  it.each([
    [RECORDED.childCompleted, 'completed'],
    [RECORDED.childFailed, 'failed'],
    [RECORDED.childAborted, 'aborted'],
  ] as const)('announces %s as a settled child', (recorded, status) => {
    const { events } = projector().handleRecorded(recorded, { ...correlation, reason: 'why' });
    expect(events).toMatchObject([
      {
        type: EventType.CUSTOM,
        name: 'bureau.child-run-settled',
        value: { childRunId: 'child-1', status },
      },
    ]);
  });

  it('announces nothing for a record that names no child', () => {
    expect(projector().handleRecorded(RECORDED.childStarted, { parentRunId: RUN }).events).toEqual(
      [],
    );
    expect(projector().handleRecorded(RECORDED.childCompleted, {}).events).toEqual([]);
  });
});

describe('the checkpoint', () => {
  it('holds only step boundaries once a step with every announcement has finished', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });
    run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: { content: '', parts: [{ type: 'thinking', thinking: 'hm', signature: 's' }] },
    });
    run.handleRecorded(RECORDED.wakeupScheduled, { duration: 1, wakeAt: 1 });
    run.handleRecorded(RECORDED.childStarted, {
      parentRunId: RUN,
      childRunId: 'c',
      childAgentName: 'w',
      durable: false,
    });
    run.handleRecorded(RECORDED.childCompleted, { childRunId: 'c' });
    run.handleRecorded(RECORDED.toolsExecuted, {
      step: 0,
      toolCalls: [{ id: 'k', name: 'memory_store', arguments: {} }],
      results: [
        {
          callId: 'k',
          toolCallId: 'k',
          toolName: 'memory_store',
          outcome: 'success',
          content: { stored: true, id: 'r', collection: 'c', memoryClass: 'episodic' },
        },
      ],
    });
    run.handleRecorded(RECORDED.stepCompleted, {
      step: 0,
      content: '',
      toolCalls: [],
      results: [],
    });

    // The tool call and its result are held rows once the conversation holds them; the
    // announcements have no row, so a checkpoint entry for one would never be released.
    const held = new Set(['run-1:step:0', 'run-1:step:0:result:k']);
    const remaining = run.snapshot(held);

    expect(
      remaining.every(
        (event) => event.type === EventType.STEP_STARTED || event.type === EventType.STEP_FINISHED,
      ),
    ).toBe(true);
  });
});
