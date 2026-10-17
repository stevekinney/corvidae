import { describe, expect, test } from 'bun:test';
import {
  bodies,
  completedConversation,
  failure,
  frames,
  runFinished,
  runStarted,
  shape,
  transcript,
} from './ag-ui-transport-test-support.ts';
import { AG_UI_UNSUPPORTED_EVENT_TYPES } from './ag-ui-transport.ts';

const snapshot = (messages: unknown[]) => ({ type: 'MESSAGES_SNAPSHOT', messages });
const text = (id: string, content: string) => [
  { type: 'TEXT_MESSAGE_START', messageId: id },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: content },
  { type: 'TEXT_MESSAGE_END', messageId: id },
];

describe('AG-UI MESSAGES_SNAPSHOT', () => {
  test('replaces the history the terminal is assembled on', async () => {
    const all = await frames([
      runStarted,
      snapshot([
        { id: 'u1', role: 'user', content: 'Hello' },
        { id: 'a1', role: 'assistant', content: 'Hi there' },
      ]),
      runFinished,
    ]);
    expect(transcript(completedConversation(all))).toEqual([
      ['user', 'Hello'],
      ['assistant', 'Hi there'],
    ]);
  });

  test('emits no frame of its own', async () => {
    const withSnapshot = await bodies([
      runStarted,
      snapshot([{ id: 'u1', role: 'user', content: 'Hello' }]),
      runFinished,
    ]);
    expect(withSnapshot.map((frame) => frame['type'])).toEqual(['run.started', 'run.completed']);
  });

  test('keeps what the run produced after it, and drops what it replaced', async () => {
    const all = await frames([
      runStarted,
      ...text('before', 'subsumed by the snapshot'),
      snapshot([{ id: 'u1', role: 'user', content: 'Hello' }]),
      ...text('after', 'streamed after the snapshot'),
      runFinished,
    ]);
    expect(transcript(completedConversation(all))).toEqual([
      ['user', 'Hello'],
      ['assistant', 'streamed after the snapshot'],
    ]);
  });

  test('the last snapshot wins', async () => {
    const all = await frames([
      runStarted,
      snapshot([{ id: 'u1', role: 'user', content: 'first' }]),
      snapshot([{ id: 'u2', role: 'user', content: 'second' }]),
      runFinished,
    ]);
    expect(transcript(completedConversation(all))).toEqual([['user', 'second']]);
  });

  test('fails with a typed error when a message has no conversation form', async () => {
    const error = await failure([
      runStarted,
      snapshot([
        {
          id: 'u1',
          role: 'user',
          content: [{ type: 'audio', source: { type: 'url', value: 'https://example.com/a.mp3' } }],
        },
      ]),
      runFinished,
    ]);
    expect(error).toMatchObject({ name: 'AGUIChatTransportError', kind: 'history', eventIndex: 1 });
  });

  test('fails with a typed error when the run cannot be assembled onto the snapshot', async () => {
    const error = await failure([
      runStarted,
      snapshot([
        {
          id: 'a1',
          role: 'assistant',
          toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'x', arguments: '{}' } }],
        },
      ]),
      { type: 'TOOL_CALL_START', toolCallId: 'call-1', toolCallName: 'x' },
      { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
      runFinished,
    ]);
    expect(error).toMatchObject({ kind: 'history', eventIndex: 4 });
  });
});

describe('AG-UI events the transport leaves alone', () => {
  const samples: Record<(typeof AG_UI_UNSUPPORTED_EVENT_TYPES)[number], unknown> = {
    STATE_SNAPSHOT: { type: 'STATE_SNAPSHOT', snapshot: { phase: 'x' } },
    STATE_DELTA: { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/a', value: 1 }] },
    ACTIVITY_SNAPSHOT: {
      type: 'ACTIVITY_SNAPSHOT',
      messageId: 'act-1',
      activityType: 'PLAN',
      content: { steps: 2 },
    },
    ACTIVITY_DELTA: {
      type: 'ACTIVITY_DELTA',
      messageId: 'act-1',
      activityType: 'PLAN',
      patch: [{ op: 'add', path: '/steps', value: 3 }],
    },
    RAW: { type: 'RAW', event: { provider: 'x' } },
    CUSTOM: { type: 'CUSTOM', name: 'telemetry', value: 1 },
    SUBAGENT_STARTED: { type: 'SUBAGENT_STARTED', subagentRunId: 's1', name: 'researcher' },
    SUBAGENT_FINISHED: { type: 'SUBAGENT_FINISHED', subagentRunId: 's1' },
    SUBAGENT_ERROR: { type: 'SUBAGENT_ERROR', subagentRunId: 's1', message: 'failed' },
  };

  test('lists every unsupported type once, including the ones the issue names', () => {
    expect(new Set(AG_UI_UNSUPPORTED_EVENT_TYPES).size).toBe(AG_UI_UNSUPPORTED_EVENT_TYPES.length);
    for (const named of [
      'STATE_SNAPSHOT',
      'STATE_DELTA',
      'ACTIVITY_SNAPSHOT',
      'ACTIVITY_DELTA',
      'RAW',
      'CUSTOM',
    ])
      expect(AG_UI_UNSUPPORTED_EVENT_TYPES).toContain(named as never);
    expect(Object.keys(samples).sort()).toEqual([...AG_UI_UNSUPPORTED_EVENT_TYPES].sort());
  });

  for (const type of AG_UI_UNSUPPORTED_EVENT_TYPES) {
    test(`${type} produces no frame and changes no state`, async () => {
      const control = await frames([runStarted, ...text('m1', 'hello'), runFinished]);
      const withEvent = await frames([
        samples[type],
        runStarted,
        samples[type],
        ...text('m1', 'hello'),
        samples[type],
        runFinished,
      ]);
      expect(shape(withEvent)).toEqual(shape(control));
    });
  }
});
