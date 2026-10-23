/**
 * A2A streams over Bureau (COR-903, part 2a): `SendStreamingMessage` and `SubscribeToTask` send the
 * task's current `Task` first, then only later events, each durable one carrying its cursor as its
 * SSE `id`, and end once the task is terminal.
 */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import {
  type OpenedBureau,
  openBureau,
  parkingUntilAborted,
} from './management/management-fixtures.test-support.ts';
import { DURABLE_HISTORY_EXTENSION_URI } from './a2a-task-stream.ts';

const PUBLIC_URL = 'http://localhost';

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
type Json = any;

type ServerSentEvent = { readonly id: string | undefined; readonly data: Json };

/** Reads a `text/event-stream` body one event at a time; `undefined` once it ends. */
function serverSentEvents(response: Response): {
  next: () => Promise<ServerSentEvent | undefined>;
  cancel: () => Promise<void>;
} {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next() {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const lines = block.split('\n');
          const data = lines.find((line) => line.startsWith('data:'));
          if (data === undefined) continue;
          const id = lines
            .find((line) => line.startsWith('id:'))
            ?.slice(3)
            .trim();
          return { id, data: JSON.parse(data.slice(5)) };
        }
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

/** What one event is: `task:<state>`, `status:<state>`, or `artifact`. */
function describe_(event: ServerSentEvent): string {
  const result = event.data.result ?? {};
  if (result.task !== undefined) return `task:${result.task.status.state}`;
  if (result.statusUpdate !== undefined) return `status:${result.statusUpdate.status.state}`;
  if (result.artifactUpdate !== undefined) return 'artifact';
  return `other:${JSON.stringify(event.data)}`;
}

async function readAll(response: Response): Promise<ServerSentEvent[]> {
  const stream = serverSentEvents(response);
  const events: ServerSentEvent[] = [];
  for (;;) {
    const event = await stream.next();
    if (event === undefined) return events;
    events.push(event);
  }
}

function rpc(
  method: string,
  params: Json,
  headers: Record<string, string> = {},
  agent = 'asker',
): Request {
  return new Request(`http://localhost/a2a/${agent}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'A2A-Version': '1.0',
      'X-API-Key': 'alice-key',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

let counter = 0;
function message(text: string, extra: Json = {}): Json {
  counter += 1;
  return { messageId: `s-${counter}`, role: 'ROLE_USER', parts: [{ text }], ...extra };
}

function answering(content: string): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

/** A model that parks the run on a human wait, then answers. */
function parksThenAnswers(): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1
      ? {
          content: '',
          toolCalls: [
            {
              id: 'wait-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response', prompt: 'Which?' },
            },
          ],
        }
      : { content: 'done', toolCalls: [] };
  };
}

async function withA2A<T>(
  generate: GenerateFunction,
  body: (opened: OpenedBureau) => Promise<T>,
  options: { humanInput?: boolean; durableHistory?: boolean } = {},
): Promise<T> {
  const opened = await openBureau({
    agents: { asker: createAgent({ name: 'asker', generate }) },
    publish: ['asker'],
    ...(options.humanInput === true ? { humanInput: true } : {}),
    ...(options.durableHistory === true ? { durableHistory: true } : {}),
    handlerOptions: { publicUrl: PUBLIC_URL },
  });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

describe('the card of a Bureau with a durable history', () => {
  it('declares streaming and the durable-history extension', async () => {
    await withA2A(
      answering('done'),
      async (opened) => {
        const response = await opened.handler(
          new Request('http://localhost/a2a/asker/.well-known/agent-card.json'),
        );
        const card: Json = await response.json();

        expect(card.capabilities.streaming).toBe(true);
        expect(card.capabilities.extensions.map((entry: Json) => entry.uri)).toContain(
          DURABLE_HISTORY_EXTENSION_URI,
        );
      },
      { durableHistory: true },
    );
  });

  it('declares no durable-history extension without a durable history', async () => {
    await withA2A(answering('done'), async (opened) => {
      const response = await opened.handler(
        new Request('http://localhost/a2a/asker/.well-known/agent-card.json'),
      );
      const card: Json = await response.json();

      expect(card.capabilities.streaming).toBe(true);
      expect(card.capabilities.extensions.map((entry: Json) => entry.uri)).not.toContain(
        DURABLE_HISTORY_EXTENSION_URI,
      );
    });
  });
});

describe('SendStreamingMessage', () => {
  it('sends the task first, then its artifact and its completion, and ends', async () => {
    await withA2A(answering('done'), async (opened) => {
      const response = await opened.handler(
        rpc('SendStreamingMessage', { message: message('go') }),
      );
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const events = await readAll(response);
      const kinds = events.map(describe_);

      expect(kinds[0]).toMatch(/^task:TASK_STATE_(SUBMITTED|WORKING|COMPLETED)$/);
      expect(kinds.at(-1)).toBe('status:TASK_STATE_COMPLETED');
      if (kinds[0] !== 'task:TASK_STATE_COMPLETED') expect(kinds.at(-2)).toBe('artifact');
      const last = events.at(-1)?.data.result.statusUpdate.status.message.parts;
      if (kinds[0] !== 'task:TASK_STATE_COMPLETED') expect(last).toEqual([{ text: 'done' }]);
      // Every kind is one of A2A's StreamResponse kinds: no step, delta, or tool frame.
      expect(kinds.every((kind) => /^(task|status|artifact)/.test(kind))).toBe(true);
    });
  });

  it.each([false, true])(
    'stays open through INPUT_REQUIRED, and follows the task to its end after a continuation (durable history: %p)',
    async (durableHistory) => {
      await withA2A(
        parksThenAnswers(),
        async (opened) => {
          const response = await opened.handler(
            rpc('SendStreamingMessage', { message: message('start') }),
          );
          const stream = serverSentEvents(response);
          const seen: string[] = [];
          let taskId = '';
          for (;;) {
            const event = await stream.next();
            if (event === undefined) throw new Error('the stream ended before INPUT_REQUIRED');
            seen.push(describe_(event));
            taskId ||= event.data.result.task?.id ?? '';
            if (seen.at(-1)?.endsWith('INPUT_REQUIRED')) break;
          }

          const answered = await opened.handler(
            rpc('SendMessage', {
              message: message('blue', { taskId }),
              configuration: { returnImmediately: true },
            }),
          );
          const answeredBody: Json = await answered.json();
          expect(answeredBody.error).toBeUndefined();
          for (;;) {
            const event = await stream.next();
            if (event === undefined) break;
            seen.push(describe_(event));
          }

          expect(seen.at(-1)).toBe('status:TASK_STATE_COMPLETED');
          expect(seen).toContain('status:TASK_STATE_WORKING');
        },
        { humanInput: true, durableHistory },
      );
    },
  );
});

describe('SubscribeToTask', () => {
  it('refuses a terminal task with -32004 before any snapshot', async () => {
    await withA2A(answering('done'), async (opened) => {
      const sent = await opened.handler(rpc('SendMessage', { message: message('x') }));
      const sentBody: Json = await sent.json();
      const task = sentBody.result.task;

      const subscribed = await opened.handler(rpc('SubscribeToTask', { id: task.id }));
      const body: Json = await subscribed.json();

      expect(body.error.code).toBe(-32004);
    });
  });

  it('sends the current task first, carrying its cursor as its SSE id and in its metadata', async () => {
    await withA2A(
      parksThenAnswers(),
      async (opened) => {
        const sent = await opened.handler(rpc('SendMessage', { message: message('start') }));
        const sentBody: Json = await sent.json();
        const parked = sentBody.result.task;
        expect(parked.status.state).toBe('TASK_STATE_INPUT_REQUIRED');

        const response = await opened.handler(
          rpc(
            'SubscribeToTask',
            { id: parked.id },
            { 'A2A-Extensions': DURABLE_HISTORY_EXTENSION_URI },
          ),
        );
        const stream = serverSentEvents(response);
        const first = await stream.next();
        await stream.cancel();

        const task = first?.data.result.task;
        expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
        const metadata = task.metadata[DURABLE_HISTORY_EXTENSION_URI];
        expect(first?.id).toBe(metadata.cursor);
        expect(metadata.cursor).not.toBe('');
        expect(response.headers.get('A2A-Extensions')).toBe(DURABLE_HISTORY_EXTENSION_URI);
      },
      { humanInput: true, durableHistory: true },
    );
  });

  it('echoes the requested cursor on a resume, and refuses one that is not a cursor with -32602', async () => {
    await withA2A(
      parksThenAnswers(),
      async (opened) => {
        const sent = await opened.handler(rpc('SendMessage', { message: message('start') }));
        const sentBody: Json = await sent.json();
        const parked = sentBody.result.task;
        const extensions = { 'A2A-Extensions': DURABLE_HISTORY_EXTENSION_URI };

        const fresh = serverSentEvents(
          await opened.handler(rpc('SubscribeToTask', { id: parked.id }, extensions)),
        );
        const opening = await fresh.next();
        await fresh.cancel();
        const resumed = serverSentEvents(
          await opened.handler(
            rpc(
              'SubscribeToTask',
              { id: parked.id },
              { ...extensions, 'Last-Event-ID': opening?.id ?? '' },
            ),
          ),
        );
        const again = await resumed.next();
        await resumed.cancel();
        const malformed = await opened.handler(
          rpc(
            'SubscribeToTask',
            { id: parked.id },
            { ...extensions, 'Last-Event-ID': 'not a cursor' },
          ),
        );
        // Without the extension the header means nothing, so it is ignored, never refused.
        const ignored = serverSentEvents(
          await opened.handler(
            rpc('SubscribeToTask', { id: parked.id }, { 'Last-Event-ID': 'not a cursor' }),
          ),
        );
        const ignoredOpening = await ignored.next();
        expect(ignoredOpening?.data.result.task.id).toBe(parked.id);
        await ignored.cancel();

        const metadata = again?.data.result.task.metadata[DURABLE_HISTORY_EXTENSION_URI];
        expect(metadata.requestedCursor).toBe(opening?.id);
        expect(metadata.gap).toBeUndefined();
        const malformedBody: Json = await malformed.json();
        expect(malformedBody.error.code).toBe(-32602);
      },
      { humanInput: true, durableHistory: true },
    );
  });

  it('leaves the task running when the subscriber goes away', async () => {
    await withA2A(parkingUntilAborted, async (opened) => {
      const sent = await opened.handler(
        rpc('SendMessage', {
          message: message('work'),
          configuration: { returnImmediately: true },
        }),
      );
      const sentBody: Json = await sent.json();
      const task = sentBody.result.task;
      await waitForCondition(() => opened.bureau.getRun(task.id)?.status === 'running', 'running');

      const stream = serverSentEvents(
        await opened.handler(rpc('SubscribeToTask', { id: task.id })),
      );
      await stream.next();
      await stream.cancel();

      const view = await opened.bureau.tasks.get(task.id);
      expect(view?.status).toBe('working');
    });
  });
});
