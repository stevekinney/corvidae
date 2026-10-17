import { describe, expect, test } from 'bun:test';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import { failure, runFinished, runStarted } from './ag-ui-transport-test-support.ts';

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
  const reasoning = { type: 'REASONING_START', messageId: 'r1' };
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
      'reasoning content before REASONING_START',
      [runStarted, { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' }],
      1,
      /before REASONING_START/,
    ],
    [
      'reasoning started twice',
      [runStarted, reasoning, reasoning],
      2,
      /Reasoning r1 started twice/,
    ],
    [
      'a reasoning message started twice',
      [
        runStarted,
        reasoning,
        { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' },
        { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' },
      ],
      3,
      /message r1 started twice/,
    ],
    [
      'reasoning content outside a message',
      [runStarted, reasoning, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'x' }],
      2,
      /outside message r1/,
    ],
    [
      'a reasoning chunk with no message id to extend',
      [runStarted, reasoning, { type: 'REASONING_MESSAGE_CHUNK', delta: 'x' }],
      2,
      /must carry a messageId/,
    ],
    [
      'reasoning ended before it started',
      [runStarted, { type: 'REASONING_END', messageId: 'r1' }],
      1,
      /before REASONING_START/,
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
