import {
  appendMessages,
  createConversationHistory,
  guardChatStreamEvents,
  type ChatStreamEvent,
} from '@lostgradient/chat';
import { rejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { acknowledgeEvent, readEvents } from './ag-ui-events.ts';
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

test('reasoning and announcements read before a disconnect are kept when the run is attached again', async () => {
  const mapper = new ResumableMapper(() => undefined);
  const first: ChatStreamEvent[] = [];
  try {
    for await (const frame of mapper.map(
      source(
        [
          started,
          { type: 'REASONING_START', messageId: 'think' },
          { type: 'REASONING_MESSAGE_START', messageId: 'think:0', role: 'reasoning' },
          { type: 'REASONING_MESSAGE_CONTENT', messageId: 'think:0', delta: 'Check ' },
          {
            type: 'CUSTOM',
            name: 'bureau.memory-written',
            value: { messageId: 'message', recordId: 'r', collection: 'c', class: 'k' },
          },
        ],
        true,
      ),
      empty(),
    ))
      first.push(frame);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
  }
  expect(first.filter((frame) => frame.type === 'stream:block-delta')).toHaveLength(1);

  const second = await Array.fromAsync(
    mapper.map(
      source([
        started,
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'think:0', delta: 'the order.' },
        { type: 'REASONING_MESSAGE_END', messageId: 'think:0' },
        { type: 'REASONING_END', messageId: 'think' },
        { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId: 'message' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message', delta: 'Done.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'message' },
        finished,
      ]),
      empty(),
    ),
  );

  // The block was opened once, by the first attachment, and the second only continues it.
  expect(second.filter((frame) => frame.type === 'stream:block-start')).toHaveLength(0);
  expect(second.filter((frame) => frame.type === 'stream:block-delta')).toMatchObject([
    { block: { content: 'Check the order.' } },
  ]);
  const terminal = second.at(-1);
  if (terminal?.type !== 'run.completed') throw new Error('Missing completion');
  expect(terminal.conversation.messages['message']?.content).toContainEqual(
    expect.objectContaining({ type: 'thinking', thinking: 'Check the order.' }),
  );
});

test('a stream that ends before its first event is the transport’s incomplete stream', async () => {
  const mapper = new ResumableMapper(() => undefined);
  const failure = await rejectionOf(Array.fromAsync(mapper.map(source([]), empty())));
  expect(failure).toMatchObject({ kind: 'incomplete-stream' });
});

describe('resume cursors committed through the real reader and Chat mapper (COR-2293)', () => {
  /** An SSE response whose frames carry the given cursors, as the Bureau writes them. */
  const sse = (frames: ReadonlyArray<readonly [unknown, string?]>): Response =>
    new Response(
      frames
        .map(
          ([event, id]) =>
            `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const stepStarted = { type: 'STEP_STARTED', stepName: 'plan' };
  const stepFinished = { type: 'STEP_FINISHED', stepName: 'plan' };

  /** The events of `response`, read as the wiring reads them, with every cursor commit recorded. */
  function read(response: Response, cursors: Array<string | undefined>): AsyncGenerator<unknown> {
    return readEvents(async () => response, { onCursor: (cursor) => cursors.push(cursor) });
  }

  /** The events of `events` up to, and not including, the first one `stop` matches, which is read. */
  async function* until(
    events: AsyncIterable<unknown>,
    stop: (event: unknown) => boolean,
  ): AsyncGenerator<unknown> {
    for await (const event of events) {
      if (stop(event)) return;
      yield event;
    }
  }

  const isStepFinished = (event: unknown): boolean =>
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'STEP_FINISHED';

  /** The resumed suffix of the run: no snapshot and no step start, as a valid cursor resume is. */
  const resumedSuffix = (): Response =>
    sse([[started], [stepFinished, 'c-plan-done'], [finished, 'c-end']]);

  test('cancelling after an event is accepted, before the next pull, keeps its cursor and journal', async () => {
    const cursors: Array<string | undefined> = [];
    const mapper = new ResumableMapper(() => undefined);
    const first = mapper.map(
      read(sse([[started], [stepStarted, 'c-plan'], [stepFinished, 'c-plan-done']]), cursors),
      empty(),
      acknowledgeEvent,
    );

    expect((await first.next()).value).toMatchObject({ type: 'run.started' });
    expect((await first.next()).value).toMatchObject({ type: 'stream:block-start' });
    // The step's start was accepted before its frame was handed over, and nothing more is pulled.
    expect(cursors).toEqual(['c-plan']);
    await first.return(undefined);
    expect(cursors).toEqual(['c-plan']);

    const resumed = await Array.fromAsync(
      mapper.map(read(resumedSuffix(), cursors), empty(), acknowledgeEvent),
    );

    expect(resumed.map((frame) => frame.type)).toEqual([
      'run.started',
      'stream:block-complete',
      'run.completed',
    ]);
    // Priming the journal acknowledged nothing a second time.
    expect(cursors).toEqual(['c-plan', 'c-plan-done', 'c-end']);
  });

  test('cancelling after an event is read, before it is accepted, keeps the old cursor and journal', async () => {
    const cursors: Array<string | undefined> = [];
    const mapper = new ResumableMapper(() => undefined);

    const failure = await rejectionOf(
      Array.fromAsync(
        mapper.map(
          until(
            read(sse([[started], [stepStarted, 'c-plan'], [stepFinished, 'c-plan-done']]), cursors),
            isStepFinished,
          ),
          empty(),
          acknowledgeEvent,
        ),
      ),
    );

    expect(failure).toMatchObject({ kind: 'incomplete-stream' });
    // The step's end was read and never accepted, so the cursor still points before it.
    expect(cursors).toEqual(['c-plan']);

    // Resuming from that cursor replays the step's end, whose start the journal holds: no start is
    // skipped and none is repeated.
    const resumed = await Array.fromAsync(
      mapper.map(read(resumedSuffix(), cursors), empty(), acknowledgeEvent),
    );
    expect(resumed.filter((frame) => frame.type === 'stream:block-start')).toEqual([]);
    expect(resumed.filter((frame) => frame.type === 'stream:block-complete')).toHaveLength(1);
    expect(resumed.at(-1)).toMatchObject({ type: 'run.completed' });
    expect(cursors).toEqual(['c-plan', 'c-plan-done', 'c-end']);
  });

  const rejected: Array<[string, ReadonlyArray<readonly [unknown, string?]>, string[], RegExp]> = [
    [
      'an unknown STEP_FINISHED',
      [
        [started],
        [stepStarted, 'c-plan'],
        [{ type: 'STEP_FINISHED', stepName: 'ghost' }, 'c-ghost'],
      ],
      ['c-plan'],
      /finished without starting/,
    ],
    [
      'a duplicate STEP_STARTED',
      [
        [started],
        [stepStarted, 'c-plan'],
        [{ type: 'STEP_STARTED', stepName: 'plan' }, 'c-duplicate'],
      ],
      ['c-plan'],
      /started twice/,
    ],
    [
      'an event after the terminal',
      [
        [started],
        [stepStarted, 'c-plan'],
        [stepFinished, 'c-plan-done'],
        [finished, 'c-end'],
        [{ type: 'STEP_STARTED', stepName: 'late' }, 'c-late'],
      ],
      ['c-plan', 'c-plan-done', 'c-end'],
      /after the run ended/,
    ],
  ];

  for (const [label, frames, committed, message] of rejected) {
    test(`${label} keeps its strict error and never moves the cursor`, async () => {
      const cursors: Array<string | undefined> = [];
      const mapper = new ResumableMapper(() => undefined);

      const failure = await rejectionOf(
        Array.fromAsync(mapper.map(read(sse(frames), cursors), empty(), acknowledgeEvent)),
      );

      expect(failure).toMatchObject({ kind: 'protocol' });
      expect((failure as Error).message).toMatch(message);
      expect(cursors).toEqual(committed);
    });
  }

  test('a snapshot cursor is committed only after the transcript has been replaced with it', async () => {
    const log: string[] = [];
    const cursors: Array<string | undefined> = [];
    const mapper = new ResumableMapper(() => {
      log.push('replaced');
    });

    await Array.fromAsync(
      mapper.map(
        readEvents(
          async () =>
            sse([
              [started],
              [stepStarted, 'c-plan'],
              [{ type: 'MESSAGES_SNAPSHOT', messages: [] }, 'c-snapshot'],
              [finished, 'c-end'],
            ]),
          {
            onCursor: (cursor) => {
              cursors.push(cursor);
              log.push(`cursor:${cursor}`);
            },
          },
        ),
        empty(),
        acknowledgeEvent,
      ),
    );

    expect(log).toEqual(['cursor:c-plan', 'replaced', 'cursor:c-snapshot', 'cursor:c-end']);
    expect(cursors).toEqual(['c-plan', 'c-snapshot', 'c-end']);
  });

  test('a snapshot whose replacement fails commits no cursor for it and fails the stream', async () => {
    const cursors: Array<string | undefined> = [];
    const refusal = new Error('the transcript could not be replaced');
    const mapper = new ResumableMapper(() => {
      throw refusal;
    });

    const failure = await rejectionOf(
      Array.fromAsync(
        mapper.map(
          read(
            sse([
              [started],
              [stepStarted, 'c-plan'],
              [{ type: 'MESSAGES_SNAPSHOT', messages: [] }, 'c-snapshot'],
              [finished, 'c-end'],
            ]),
            cursors,
          ),
          empty(),
          acknowledgeEvent,
        ),
      ),
    );

    expect(failure).toBe(refusal);
    expect(cursors).toEqual(['c-plan']);
  });

  test('a terminal event commits its cursor before its frame, with no later pull', async () => {
    const cursors: Array<string | undefined> = [];
    const mapper = new ResumableMapper(() => undefined);
    const frames = mapper.map(
      read(
        sse([
          [started],
          [stepStarted, 'c-plan'],
          [stepFinished, 'c-plan-done'],
          [finished, 'c-end'],
        ]),
        cursors,
      ),
      empty(),
      acknowledgeEvent,
    );

    for (;;) {
      const next = await frames.next();
      if (next.done === true) throw new Error('The stream ended before its terminal.');
      if (next.value.type === 'run.completed') break;
    }

    expect(cursors).toEqual(['c-plan', 'c-plan-done', 'c-end']);
    await frames.return(undefined);
  });
});
