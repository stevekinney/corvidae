import { describe, expect, test } from 'bun:test';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import { failure, frames, runFinished, runStarted } from './ag-ui-transport-test-support.ts';

describe('AG-UI event validation', () => {
  const invalid: Array<[string, unknown]> = [
    ['an unknown event type', { type: 'NOT_AN_EVENT' }],
    ['a missing required field', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1' }],
    ['a field of the wrong type', { type: 'TEXT_MESSAGE_CONTENT', messageId: 7, delta: 'x' }],
    ['a value that is not an object', 42],
    ['null', null],
  ];

  for (const [label, event] of invalid) {
    test(`fails the run with a typed error for ${label}`, async () => {
      const error = await failure([runStarted, event, runFinished]);
      expect(error).toBeInstanceOf(AGUIChatTransportError);
      expect(error).toMatchObject({
        name: 'AGUIChatTransportError',
        kind: 'invalid-event',
        eventIndex: 1,
      });
      expect((error as AGUIChatTransportError).cause).toBeDefined();
      expect((error as AGUIChatTransportError).message).toContain('@ag-ui/core event schema');
    });
  }

  test('validates events that are otherwise ignored', async () => {
    const error = await failure([runStarted, { type: 'STATE_DELTA' }, runFinished]);
    expect(error).toMatchObject({ kind: 'invalid-event', eventIndex: 1 });
  });
});

describe('AG-UI event order', () => {
  const text = { type: 'TEXT_MESSAGE_START', messageId: 'm1' };
  const call = { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'tool' };
  const span = { type: 'REASONING_START', messageId: 'span-1' };
  const messageStart = (messageId: string) => ({
    type: 'REASONING_MESSAGE_START',
    messageId,
    role: 'reasoning',
  });
  const cases: Array<[string, unknown[], number, RegExp]> = [
    ['an event before RUN_STARTED', [text], 0, /before RUN_STARTED/],
    ['RUN_STARTED twice', [runStarted, runStarted], 1, /RUN_STARTED arrived twice/],
    ['an event after the run ended', [runStarted, runFinished, text], 2, /after the run ended/],
    [
      'RUN_FINISHED with a text message open',
      [runStarted, text, runFinished],
      2,
      /m1 was still open/,
    ],
    ['RUN_FINISHED with a tool call open', [runStarted, call, runFinished], 2, /c1 was still open/],
    [
      'a step started twice',
      [
        runStarted,
        { type: 'STEP_STARTED', stepName: 's' },
        { type: 'STEP_STARTED', stepName: 's' },
      ],
      2,
      /Step s started twice/,
    ],
    [
      'a step finished before it started',
      [runStarted, { type: 'STEP_FINISHED', stepName: 's' }],
      1,
      /finished without starting/,
    ],
    ['a text message started twice', [runStarted, text, text], 2, /m1 started twice/],
    [
      'a text message id used again after the message ended',
      [runStarted, text, { type: 'TEXT_MESSAGE_END', messageId: 'm1' }, text],
      3,
      /m1 started twice/,
    ],
    [
      'text content for an unopened message',
      [runStarted, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' }],
      1,
      /unopened message m1/,
    ],
    [
      'a text message ended before it started',
      [runStarted, { type: 'TEXT_MESSAGE_END', messageId: 'm1' }],
      1,
      /ended without starting/,
    ],
    [
      'a text chunk with no message id to extend',
      [runStarted, { type: 'TEXT_MESSAGE_CHUNK', delta: 'x' }],
      1,
      /must carry a messageId/,
    ],
    ['a tool call started twice', [runStarted, call, call], 2, /Tool call c1 started twice/],
    [
      'arguments for an unopened tool call',
      [runStarted, { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{}' }],
      1,
      /unopened call c1/,
    ],
    [
      'a tool call ended before it started',
      [runStarted, { type: 'TOOL_CALL_END', toolCallId: 'c1' }],
      1,
      /ended without starting/,
    ],
    [
      'a tool call restarted after it ended',
      [runStarted, call, { type: 'TOOL_CALL_END', toolCallId: 'c1' }, call],
      3,
      /started twice/,
    ],
    [
      'a tool chunk with no call id to extend',
      [runStarted, { type: 'TOOL_CALL_CHUNK', delta: '{}' }],
      1,
      /must carry a toolCallId/,
    ],
    [
      'a first tool chunk with no name',
      [runStarted, { type: 'TOOL_CALL_CHUNK', toolCallId: 'c1' }],
      1,
      /must carry a toolCallName/,
    ],
    [
      'a result before its call ended',
      [
        runStarted,
        call,
        { type: 'TOOL_CALL_RESULT', messageId: 't1', toolCallId: 'c1', content: 'x' },
      ],
      2,
      /has not ended/,
    ],
    [
      'a reasoning message outside any span',
      [runStarted, { type: 'REASONING_MESSAGE_START', messageId: 'm1', role: 'reasoning' }],
      1,
      /outside a REASONING_START span/,
    ],
    [
      'a reasoning span started twice',
      [runStarted, span, span],
      2,
      /Reasoning span-1 started twice/,
    ],
    [
      'a reasoning message started twice',
      [runStarted, span, messageStart('m1'), messageStart('m1')],
      3,
      /message m1 started twice/,
    ],
    [
      'reasoning content for a message that never started',
      [runStarted, span, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' }],
      2,
      /content arrived outside message m1/,
    ],
    [
      'reasoning content addressed by the span id instead of its message',
      [
        runStarted,
        span,
        messageStart('m1'),
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'span-1', delta: 'x' },
      ],
      3,
      /outside message span-1/,
    ],
    [
      'reasoning content after its message ended',
      [
        runStarted,
        span,
        messageStart('m1'),
        { type: 'REASONING_MESSAGE_END', messageId: 'm1' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' },
      ],
      4,
      /outside message m1/,
    ],
    [
      'a reasoning message ended before it started',
      [runStarted, span, { type: 'REASONING_MESSAGE_END', messageId: 'm1' }],
      2,
      /end arrived outside message m1/,
    ],
    [
      'a reasoning span that ends with a message still open',
      [runStarted, span, messageStart('m1'), { type: 'REASONING_END', messageId: 'span-1' }],
      3,
      /message m1 was still open/,
    ],
    [
      'a reasoning chunk with no message id to extend',
      [runStarted, span, { type: 'REASONING_MESSAGE_CHUNK', delta: 'x' }],
      2,
      /must carry a messageId/,
    ],
    [
      'a reasoning span ended before it started',
      [runStarted, { type: 'REASONING_END', messageId: 'span-1' }],
      1,
      /ended before REASONING_START/,
    ],
    [
      'RUN_FINISHED with a foreign-role text message still open',
      [runStarted, { type: 'TEXT_MESSAGE_START', messageId: 'u1', role: 'user' }, runFinished],
      2,
      /u1 was still open/,
    ],
    [
      'RUN_FINISHED with a reasoning span still open',
      [runStarted, span, runFinished],
      2,
      /span-1 was still open/,
    ],
    [
      'a text chunk continuation that changes the role',
      [
        runStarted,
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'a' },
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'user', delta: 'b' },
      ],
      2,
      /changed its role from assistant to user/,
    ],
    [
      'a tool chunk continuation that changes the tool name',
      [
        runStarted,
        { type: 'TOOL_CALL_CHUNK', toolCallId: 'c1', toolCallName: 'first', delta: '{' },
        { type: 'TOOL_CALL_CHUNK', toolCallId: 'c1', toolCallName: 'second', delta: '}' },
      ],
      2,
      /changed its toolCallName from first to second/,
    ],
  ];

  for (const [label, events, eventIndex, message] of cases) {
    test(`fails the run with a typed error for ${label}`, async () => {
      const error = await failure(events);
      expect(error).toBeInstanceOf(AGUIChatTransportError);
      expect(error).toMatchObject({ kind: 'protocol', eventIndex });
      expect((error as AGUIChatTransportError).message).toMatch(message);
    });
  }
});

describe('AG-UI chunk runs and the events between them', () => {
  const ignored = [
    { type: 'STATE_SNAPSHOT', snapshot: {} },
    { type: 'STATE_DELTA', delta: [] },
    { type: 'CUSTOM', name: 'n', value: 1 },
    { type: 'RAW', event: {} },
    { type: 'ACTIVITY_SNAPSHOT', messageId: 'act', activityType: 'PLAN', content: {} },
    { type: 'ACTIVITY_DELTA', messageId: 'act', activityType: 'PLAN', patch: [] },
  ];

  for (const event of ignored) {
    test(`${event.type} ends an open text chunk run, so an id-less chunk after it is rejected`, async () => {
      const error = await failure([
        runStarted,
        { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' },
        event,
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'b' },
      ]);
      expect(error).toMatchObject({ kind: 'protocol', eventIndex: 3 });
      expect((error as Error).message).toMatch(/must carry a messageId/);
    });

    test(`${event.type} ends an open tool chunk run, so an id-less chunk after it is rejected`, async () => {
      const error = await failure([
        runStarted,
        { type: 'TOOL_CALL_CHUNK', toolCallId: 'c1', toolCallName: 'tool', delta: '{' },
        event,
        { type: 'TOOL_CALL_CHUNK', delta: '}' },
      ]);
      expect(error).toMatchObject({ kind: 'protocol', eventIndex: 3 });
      expect((error as Error).message).toMatch(/must carry a toolCallId/);
    });
  }

  test('the frames that end the run come out at the event that ended it', async () => {
    const all = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' },
      { type: 'CUSTOM', name: 'n', value: 1 },
      runFinished,
    ]);
    expect(all.map((frame) => frame.type)).toEqual([
      'run.started',
      'assistant.step.started',
      'stream:text-delta',
      'assistant.step.completed',
      'run.completed',
    ]);
  });
});

describe('AG-UI events after the run ends', () => {
  const ignored = [
    { type: 'STATE_SNAPSHOT', snapshot: {} },
    { type: 'STATE_DELTA', delta: [] },
    { type: 'CUSTOM', name: 'n', value: 1 },
    { type: 'RAW', event: {} },
    { type: 'ACTIVITY_SNAPSHOT', messageId: 'act', activityType: 'PLAN', content: {} },
    { type: 'ACTIVITY_DELTA', messageId: 'act', activityType: 'PLAN', patch: [] },
  ];

  for (const [label, ending] of [
    ['RUN_FINISHED', runFinished],
    ['RUN_ERROR', { type: 'RUN_ERROR', message: 'failed' }],
  ] as const) {
    for (const event of ignored) {
      test(`${event.type} after ${label} is a lifecycle error`, async () => {
        const error = await failure([runStarted, ending, event]);
        expect(error).toMatchObject({ kind: 'protocol', eventIndex: 2 });
        expect((error as Error).message).toMatch(/arrived after the run ended/);
      });
    }
  }
});
