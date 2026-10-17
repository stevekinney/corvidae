import { describe, expect, test } from 'bun:test';
import { fromAGUIMessages } from 'conversationalist';
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

  test('each snapshot adds the rows the thread lacks and removes none', async () => {
    const all = await frames([
      runStarted,
      snapshot([{ id: 'u1', role: 'user', content: 'first' }]),
      snapshot([
        { id: 'u1', role: 'user', content: 'rewritten' },
        { id: 'u2', role: 'user', content: 'second' },
      ]),
      snapshot([{ id: 'u3', role: 'user', content: 'third' }]),
      runFinished,
    ]);
    expect(transcript(completedConversation(all))).toEqual([
      ['user', 'first'],
      ['user', 'second'],
      ['user', 'third'],
    ]);
  });

  test('never changes or removes a row the client already has', async () => {
    const asked = fromAGUIMessages([
      { id: 'u1', role: 'user', content: 'mine' },
      { id: 'a1', role: 'assistant', content: 'mine too' },
    ]);
    const all = await frames(
      [
        runStarted,
        snapshot([
          { id: 'u1', role: 'user', content: 'theirs' },
          { id: 'u2', role: 'user', content: 'new' },
        ]),
        ...text('a2', 'streamed'),
        runFinished,
      ],
      asked,
    );
    const rows = completedConversation(all);
    expect(rows.ids).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(transcript(rows)).toEqual([
      ['user', 'mine'],
      ['assistant', 'mine too'],
      ['user', 'new'],
      ['assistant', 'streamed'],
    ]);
  });

  test('a streamed message the snapshot already holds is not added twice', async () => {
    const all = await frames([
      runStarted,
      ...text('a1', 'streamed'),
      snapshot([{ id: 'a1', role: 'assistant', content: 'in the snapshot' }]),
      runFinished,
    ]);
    expect(transcript(completedConversation(all))).toEqual([['assistant', 'in the snapshot']]);
  });

  test('a message still streaming when a snapshot arrives is kept', async () => {
    const all = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'a1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'before ' },
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'tool' },
      snapshot([{ id: 'u1', role: 'user', content: 'Hello' }]),
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'and after' },
      { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      runFinished,
    ]);
    expect(completedConversation(all).ids).toEqual(['u1', 'a1', 'c1:message']);
  });

  test('a reasoning message still streaming when a snapshot arrives is kept', async () => {
    const all = await frames([
      runStarted,
      { type: 'REASONING_START', messageId: 'span-1' },
      { type: 'REASONING_MESSAGE_START', messageId: 'msg-1', role: 'reasoning' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'msg-1', delta: 'before ' },
      snapshot([{ id: 'u1', role: 'user', content: 'Hello' }]),
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'msg-1', delta: 'after' },
      { type: 'REASONING_MESSAGE_END', messageId: 'msg-1' },
      { type: 'REASONING_END', messageId: 'span-1' },
      runFinished,
    ]);
    expect(transcript(completedConversation(all))).toEqual([
      ['user', 'Hello'],
      ['assistant', [{ type: 'thinking', thinking: 'before after', signature: '' }]],
    ]);
  });

  test('drops the messages of a subagent from a snapshot', async () => {
    const all = await frames([
      runStarted,
      snapshot([
        { id: 'u1', role: 'user', content: 'Hello' },
        { id: 'sub-1', role: 'assistant', content: 'subagent notes', subagentRunId: 's1' },
      ]),
      runFinished,
    ]);
    expect(transcript(completedConversation(all))).toEqual([['user', 'Hello']]);
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

describe('AG-UI events that belong to a subagent', () => {
  test('are not attributed to the thread, whatever their type', async () => {
    const all = await bodies([
      runStarted,
      { type: 'SUBAGENT_STARTED', subagentRunId: 's1', name: 'researcher' },
      { type: 'TEXT_MESSAGE_START', messageId: 'sub', subagentRunId: 's1' },
      {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'sub',
        delta: 'subagent notes',
        subagentRunId: 's1',
      },
      { type: 'TEXT_MESSAGE_END', messageId: 'sub', subagentRunId: 's1' },
      { type: 'TOOL_CALL_START', toolCallId: 'sc', toolCallName: 'tool', subagentRunId: 's1' },
      {
        type: 'TOOL_CALL_RESULT',
        messageId: 'st',
        toolCallId: 'sc',
        content: 'x',
        subagentRunId: 's1',
      },
      { type: 'SUBAGENT_FINISHED', subagentRunId: 's1' },
      ...text('m1', 'parent answer'),
      runFinished,
    ]);
    expect(all.map((frame) => frame['type'])).toEqual([
      'run.started',
      'assistant.step.started',
      'stream:text-delta',
      'assistant.step.completed',
      'run.completed',
    ]);
    expect(all.at(-1)).toMatchObject({ content: 'parent answer' });
  });

  test('cannot collide with a step of the parent that has the same name', async () => {
    const all = await bodies([
      runStarted,
      { type: 'STEP_STARTED', stepName: 'plan' },
      { type: 'STEP_STARTED', stepName: 'plan', subagentRunId: 's1' },
      { type: 'STEP_FINISHED', stepName: 'plan', subagentRunId: 's1' },
      { type: 'STEP_FINISHED', stepName: 'plan' },
      runFinished,
    ]);
    expect(all.map((frame) => frame['type'])).toEqual([
      'run.started',
      'stream:block-start',
      'stream:block-complete',
      'run.completed',
    ]);
  });

  test('do not end a parent chunk run they are interleaved with', async () => {
    const all = await bodies([
      runStarted,
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' },
      { type: 'CUSTOM', name: 'n', value: 1, subagentRunId: 's1' },
      { type: 'TEXT_MESSAGE_CHUNK', delta: 'b' },
      runFinished,
    ]);
    expect(all.filter((frame) => frame['type'] === 'stream:text-delta')).toHaveLength(2);
  });
});
