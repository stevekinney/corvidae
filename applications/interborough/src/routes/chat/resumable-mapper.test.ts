import {
  appendMessages,
  createConversationHistory,
  guardChatStreamEvents,
  type ChatStreamEvent,
} from '@lostgradient/chat';
import { rejectionOf } from '@lostgradient/testing';
import { expect, test } from 'bun:test';
import { ResumableMapper } from './resumable-mapper.ts';

const started = { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' };
const finished = { type: 'RUN_FINISHED', threadId: 'thread', runId: 'run' };
async function* source(events: unknown[], fail = false) {
  yield* events;
  if (fail) throw new TypeError('disconnected');
}
const empty = () => createConversationHistory({ id: 'thread' });

test('a suffix after TEXT_MESSAGE_START continues the real Chat mapper without replayed output', async () => {
  const mapper = new ResumableMapper(() => undefined);
  const before: ChatStreamEvent[] = [];
  try {
    for await (const frame of mapper.map(
      source(
        [
          started,
          { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId: 'message' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message', delta: 'Hello' },
        ],
        true,
      ),
      empty(),
    ))
      before.push(frame);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
  }
  const after = await Array.fromAsync(
    mapper.map(
      source([
        started,
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message', delta: ' world' },
        { type: 'TEXT_MESSAGE_END', messageId: 'message' },
        finished,
      ]),
      empty(),
    ),
  );
  expect(after.filter((frame) => frame.type === 'stream:text-delta')).toMatchObject([
    { content: ' world', accumulated: 'Hello world' },
  ]);
  expect(after.filter((frame) => frame.type === 'assistant.step.started')).toHaveLength(0);
  const terminal = after.at(-1);
  expect(terminal).toMatchObject({ type: 'run.completed', content: 'Hello world' });
  if (terminal?.type !== 'run.completed') throw new Error('Missing completion');
  expect(terminal.conversation.ids).toEqual(['message']);
});

test('every snapshot replaces prior and partial rows, including one midway through an attachment', async () => {
  let restored = empty();
  const mapper = new ResumableMapper((history) => {
    restored = history;
  });
  const prior = appendMessages(empty(), { id: 'stale', role: 'assistant', content: 'remove me' });
  const frames = await Array.fromAsync(
    mapper.map(
      source([
        started,
        { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId: 'partial' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'partial', delta: 'partial' },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [{ id: 'authoritative', role: 'assistant', content: 'replacement' }],
        },
        finished,
      ]),
      prior,
    ),
  );
  expect(restored.ids).toEqual(['authoritative']);
  const terminal = frames.at(-1);
  if (terminal?.type !== 'run.completed') throw new Error('Missing completion');
  expect(terminal.conversation.ids).toEqual(['authoritative']);
});

test('a future committed snapshot row and its later canonical projection reconcile once', async () => {
  const mapper = new ResumableMapper(() => undefined);
  const frames = await Array.fromAsync(
    mapper.map(
      source([
        started,
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [{ id: 'answer', role: 'assistant', content: 'Out of steps.' }],
        },
        { type: 'TEXT_MESSAGE_START', messageId: 'answer', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'Out of steps.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'answer' },
        finished,
      ]),
      empty(),
    ),
  );
  const terminal = frames.at(-1);
  if (terminal?.type !== 'run.completed') throw new Error('Missing completion');
  expect(terminal.conversation.ids).toEqual(['answer']);
  expect(terminal.conversation.messages['answer']?.content).toBe('Out of steps.');
});

test('a real empty snapshot clears every stale row and all partial mapper state', async () => {
  let restored = appendMessages(empty(), { id: 'old', role: 'user', content: 'old' });
  const mapper = new ResumableMapper((history) => {
    restored = history;
  });
  const frames = await Array.fromAsync(
    mapper.map(
      source([
        started,
        { type: 'TEXT_MESSAGE_START', messageId: 'partial', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'partial', delta: 'partial' },
        { type: 'MESSAGES_SNAPSHOT', messages: [] },
        finished,
      ]),
      restored,
    ),
  );
  expect(restored.ids).toEqual([]);
  const terminal = frames.at(-1);
  if (terminal?.type !== 'run.completed') throw new Error('Missing completion');
  expect(terminal.conversation.ids).toEqual([]);
});

test('a disconnect immediately after TEXT_MESSAGE_START resumes with content, not another start', async () => {
  const mapper = new ResumableMapper(() => undefined);
  expect(
    await rejectionOf(
      Array.fromAsync(
        mapper.map(
          source(
            [started, { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId: 'message' }],
            true,
          ),
          empty(),
        ),
      ),
    ),
  ).toBeInstanceOf(TypeError);
  const frames = await Array.fromAsync(
    mapper.map(
      source([
        started,
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message', delta: 'First content' },
        { type: 'TEXT_MESSAGE_END', messageId: 'message' },
        finished,
      ]),
      empty(),
    ),
  );
  expect(frames.filter((frame) => frame.type === 'assistant.step.started')).toEqual([]);
  expect(frames.filter((frame) => frame.type === 'stream:text-delta')).toMatchObject([
    { content: 'First content', accumulated: 'First content' },
  ]);
  expect(frames.at(-1)).toMatchObject({ type: 'run.completed', content: 'First content' });
});

test('the actual Chat guard accepts text followed by an authoritative snapshot and terminal', async () => {
  const mapper = new ResumableMapper(() => undefined);
  const frames = await Array.fromAsync(
    guardChatStreamEvents(
      mapper.map(
        source([
          started,
          { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId: 'message' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message', delta: 'Hello' },
          { type: 'TEXT_MESSAGE_END', messageId: 'message' },
          {
            type: 'MESSAGES_SNAPSHOT',
            messages: [
              { id: 'message', role: 'assistant', content: 'Hello' },
              { id: 'input', role: 'user', content: 'Follow-up' },
            ],
          },
          finished,
        ]),
        empty(),
      ),
    ),
  );
  expect(frames.map((frame) => frame.sequence)).toEqual(frames.map((_frame, index) => index));
  const terminal = frames.at(-1);
  expect(terminal).toMatchObject({ type: 'run.completed' });
  if (terminal?.type !== 'run.completed') throw new Error('Missing completion');
  expect(terminal.conversation.ids).toEqual(['message', 'input']);
});

test('an attachment that carries no events fails as an incomplete stream, not as a hang', async () => {
  const mapper = new ResumableMapper(() => undefined);

  const rejection = await rejectionOf(Array.fromAsync(mapper.map(source([]), empty())));

  expect(rejection).toMatchObject({ kind: 'incomplete-stream' });
});

test('a stream that opens with an event Chat ignores goes to Chat whole, rest of the stream included', async () => {
  const mapper = new ResumableMapper(() => undefined);
  const events = [
    { type: 'CUSTOM', name: 'warm-up', value: 1 },
    started,
    { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId: 'message' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message', delta: 'Hi' },
    { type: 'TEXT_MESSAGE_END', messageId: 'message' },
    finished,
  ];
  const pulled: unknown[] = [];
  async function* watched() {
    for (const event of events) {
      pulled.push(event);
      yield event;
    }
  }

  const frames = await Array.fromAsync(mapper.map(watched(), empty()));

  expect(pulled).toEqual(events);
  expect(frames.at(-1)).toMatchObject({ type: 'run.completed', content: 'Hi' });
});

test('the argument chunks of one tool call are kept as one, and a resumed attachment is primed with them', async () => {
  const mapper = new ResumableMapper(() => undefined);
  const call = { type: 'TOOL_CALL_START', toolCallId: 'call', toolCallName: 'lookup-order' };
  const before: ChatStreamEvent[] = [];
  try {
    for await (const frame of mapper.map(
      source(
        [
          started,
          call,
          { type: 'TOOL_CALL_ARGS', toolCallId: 'call', delta: '{"order' },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'call', delta: 'Id":"o1"}' },
        ],
        true,
      ),
      empty(),
    ))
      before.push(frame);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
  }

  const after = await Array.fromAsync(
    mapper.map(
      source([
        started,
        { type: 'TOOL_CALL_END', toolCallId: 'call' },
        { type: 'RUN_FINISHED', threadId: 'thread', runId: 'run' },
      ]),
      empty(),
    ),
  );

  expect(after.at(-1)).toMatchObject({ type: 'run.completed' });
});
