/**
 * COR-1547 — where the projector puts a step's `bureau.asset-part` events. A model that streams
 * has opened its text message with deltas before `generate.completed` arrives, and a model that
 * does not has opened nothing; the events stay inside the message either way. Every Bureau test
 * with a scripted model takes the second path, so the first is pinned here.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';

import { RECORDED, RunProjector } from './ag-ui-projection.ts';

const RUN = 'run-1';
const projector = () =>
  new RunProjector(RUN, { nativeRunId: RUN, sessionId: 'thread-1', now: () => 1 });
const asset = (assetId: string) => ({
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'managed-asset', assetId },
});

describe('the asset events of a step whose text streamed', () => {
  it('come after the streamed deltas and before TEXT_MESSAGE_END, in ascending index', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });
    const first = run.handleTextDelta('Here', 'Here');
    const second = run.handleTextDelta(' they', 'Here they');
    const done = run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: {
        content: 'Here they are.',
        parts: [{ type: 'text', text: 'Here they are.' }, asset('a-1'), asset('a-2')],
      },
    });

    const events = [...first.events, ...second.events, ...done.events];

    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.CUSTOM,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(done.events.filter((event) => event.type === EventType.CUSTOM)).toMatchObject([
      { name: 'bureau.asset-part', value: { messageId: 'run-1:step:0', index: 1, assetId: 'a-1' } },
      { name: 'bureau.asset-part', value: { messageId: 'run-1:step:0', index: 2, assetId: 'a-2' } },
    ]);
  });

  it('are announced once, even when the step’s own completion repeats the text', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });
    run.handleTextDelta('Here', 'Here');
    const done = run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: { content: 'Here', parts: [{ type: 'text', text: 'Here' }, asset('a-1')] },
    });
    const finished = run.handleRecorded(RECORDED.stepCompleted, { step: 0, content: 'Here' });

    const customs = [...done.events, ...finished.events].filter(
      (event) => event.type === EventType.CUSTOM,
    );
    expect(customs).toHaveLength(1);
  });
});

describe('the asset events of a step whose text did not stream', () => {
  it('sit between the message’s start and its end, after its text', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const done = run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: {
        content: 'Here.',
        parts: [{ type: 'text', text: 'Here.' }, asset('a-1')],
      },
    });

    expect(done.events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_END,
    ]);
  });

  it('get a message of their own when the step has no text', () => {
    const run = projector();
    run.handleRecorded(RECORDED.stepStarted, { step: 0 });

    const done = run.handleRecorded(RECORDED.generateCompleted, {
      step: 0,
      response: { content: '', parts: [asset('a-1')] },
    });

    expect(done.events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_END,
    ]);
  });
});
