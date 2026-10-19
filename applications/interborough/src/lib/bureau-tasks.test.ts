import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { Fetcher } from './bureau-client.ts';
import {
  cancelTask,
  followTaskEvents,
  getTask,
  isTerminalState,
  listTasks,
  respondToTask,
  taskCancelReceiptSchema,
  taskCleanupSchema,
  taskEventsPath,
  type TaskEvent,
} from './bureau-tasks.ts';
import { classifyFault } from './faults.ts';

const TASK = {
  id: 'run-1',
  contextId: 'session-1',
  agentName: 'assistant',
  owner: 'anonymous:local',
  actor: null,
  status: 'working',
  finishReason: null,
  statusMessage: null,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T08:00:01.000Z',
  cleanup: null,
  openWaits: [],
};

type Call = { url: string; method: string; params: unknown };

/** A fetch that answers each JSON-RPC call with `result` and records what it was asked. */
function answering(result: unknown) {
  const calls: Call[] = [];
  const stub: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      method: string;
      params: unknown;
    };
    calls.push({ url, method: body.method, params: body.params });
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  return { calls, fetch: stub };
}

async function withFetch<T>(stub: Fetcher, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(stub, { preconnect: original.preconnect });
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe('the task operations', () => {
  test('list asks for a page with the filters, and parses the tasks and the next offset', async () => {
    const stub = answering({ tasks: [TASK], nextOffset: 50 });
    const page = await withFetch(stub.fetch, () =>
      listTasks({ contextId: 'session-1', agentName: 'assistant', status: 'working', offset: 50 }),
    );
    expect(stub.calls).toEqual([
      {
        url: '/bureau/jsonrpc',
        method: 'bureau.tasks.list',
        params: { contextId: 'session-1', agentName: 'assistant', status: 'working', offset: 50 },
      },
    ]);
    expect(page.nextOffset).toBe(50);
    expect(page.tasks[0]?.id).toBe('run-1');
  });

  test('get reads one task by its id', async () => {
    const stub = answering({
      ...TASK,
      openWaits: [{ kind: 'human-wait', reviewId: 'review-1', signalName: 'environment' }],
    });
    const task = await withFetch(stub.fetch, () => getTask('run-1'));
    expect(stub.calls[0]).toMatchObject({
      method: 'bureau.tasks.get',
      params: { taskId: 'run-1' },
    });
    expect(task.openWaits).toEqual([
      { kind: 'human-wait', reviewId: 'review-1', signalName: 'environment' },
    ]);
  });

  test('a task the Bureau answers with an unknown state is a fault, not data to show', async () => {
    const stub = answering({ ...TASK, status: 'exploded' });
    expect(await rejectionOf(withFetch(stub.fetch, () => getTask('run-1')))).toBeInstanceOf(Error);
  });

  test('cancel names the task and answers the receipt, with the task when the caller may read it', async () => {
    const stub = answering({ taskId: 'run-1', receipt: 'cancel-requested', task: TASK });
    const answer = await withFetch(stub.fetch, () => cancelTask('run-1'));
    expect(stub.calls[0]).toMatchObject({
      method: 'bureau.tasks.cancel',
      params: { taskId: 'run-1' },
    });
    expect(answer.receipt).toBe('cancel-requested');
    expect(answer.task?.id).toBe('run-1');
  });

  test('respond sends the answer to the wait it names, under a message identifier', async () => {
    const stub = answering({
      taskId: 'run-1',
      messageId: 'message-1',
      reviewId: 'review-1',
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    });
    const answer = await withFetch(stub.fetch, () =>
      respondToTask({
        taskId: 'run-1',
        messageId: 'message-1',
        answer: 'staging',
        signalName: 'environment',
      }),
    );
    expect(stub.calls[0]).toMatchObject({
      method: 'bureau.tasks.respond',
      params: {
        taskId: 'run-1',
        messageId: 'message-1',
        answer: 'staging',
        signalName: 'environment',
      },
    });
    expect(answer.receipt).toBe('applied');
  });

  test('the receipt is the cleanup states and rejected, and nothing else', () => {
    expect(taskCancelReceiptSchema.options).toEqual([...taskCleanupSchema.options, 'rejected']);
    expect(taskCancelReceiptSchema.options).toHaveLength(8);
  });

  test('a task is over when it completed, failed, or was canceled', () => {
    expect(
      ['submitted', 'working', 'input-required'].map((s) => isTerminalState(s as never)),
    ).toEqual([false, false, false]);
    expect(['completed', 'failed', 'canceled'].map((s) => isTerminalState(s as never))).toEqual([
      true,
      true,
      true,
    ]);
  });
});

function sse(frames: readonly { id?: string; event: string; data: unknown }[]): Response {
  const text = frames
    .map(
      (frame) =>
        `${frame.id === undefined ? '' : `id: ${frame.id}\n`}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
    )
    .join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(stream: AsyncGenerator<TaskEvent, void, void>): Promise<TaskEvent[]> {
  const elements: TaskEvent[] = [];
  for await (const element of stream) elements.push(element);
  return elements;
}

const SNAPSHOT = {
  taskId: 'run-1',
  cursor: '-1',
  emittedAtMs: 1,
  kind: 'task.snapshot',
  status: 'working',
  finishReason: null,
  message: null,
};

describe('following a task', () => {
  test('opens the generic subscription route with the task, and resumes with Last-Event-ID', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const stub: Fetcher = async (input, init) => {
      seen.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        headers: new Headers(init?.headers),
      });
      return sse([]);
    };
    await collect(followTaskEvents('run-1', { fetch: stub }));
    await collect(followTaskEvents('run-1', { fetch: stub, cursor: '16' }));
    expect(seen[0]?.url).toBe('/bureau/v1/subscriptions/bureau.tasks.events?taskId=run-1');
    expect(seen[0]?.url).toBe(taskEventsPath('run-1'));
    expect(seen[0]?.headers.get('last-event-id')).toBeNull();
    expect(seen[1]?.headers.get('last-event-id')).toBe('16');
    expect(seen[1]?.headers.get('accept')).toBe('text/event-stream');
  });

  test('yields each task element, and skips heartbeats and frames that do not parse', async () => {
    const status = {
      taskId: 'run-1',
      cursor: '16',
      emittedAtMs: 2,
      kind: 'task.status',
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
      artifact: { artifactId: 'run-1:result', text: 'Done.', truncated: false },
    };
    const stub: Fetcher = async () =>
      sse([
        { id: '-1', event: 'task.snapshot', data: SNAPSHOT },
        { event: 'ping', data: { emittedAtMs: 1, replayComplete: true } },
        { id: '9', event: 'task.status', data: { nonsense: true } },
        { id: '16', event: 'task.status', data: status },
      ]);
    const elements = await collect(followTaskEvents('run-1', { fetch: stub }));
    expect(elements.map((element) => element.kind)).toEqual(['task.snapshot', 'task.status']);
    expect(elements[1]).toMatchObject({ artifact: { text: 'Done.' } });
  });

  test('a refusal is the fault its status says it is, so a missing task reads as not found', async () => {
    const stub: Fetcher = async () =>
      Response.json({ error: 'No task with id "run-9"' }, { status: 404 });
    const failure = await collect(followTaskEvents('run-9', { fetch: stub })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HttpClientError);
    expect(classifyFault(failure)?.kind).toBe('not-found');
  });
});
