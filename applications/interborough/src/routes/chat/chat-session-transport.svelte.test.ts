/**
 * What a session says of its own transports, and when a new chat's history may be read (COR-2293).
 */
import { appendMessages } from '@lostgradient/chat';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, expect, test } from 'bun:test';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { ChatSessionState } from './chat-session.svelte.ts';
import { AG_UI_PATH } from './run-wiring.ts';

const sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});
const open = (fetch: Fetcher, options: { readonly unopened?: boolean } = {}) => {
  const session = new ChatSessionState({
    sessionId: 'thread',
    agentName: () => 'assistant',
    fetch,
    ...options,
  });
  sessions.push(session);
  return session;
};
const urlOf = (input: Parameters<Fetcher>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const sse = (events: readonly unknown[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const encoded = (event: unknown, id?: string) =>
  new TextEncoder().encode(
    `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`,
  );
const started = { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' };
const finished = { type: 'RUN_FINISHED', threadId: 'thread', runId: 'run' };
const reply = [
  { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Hi.' },
  { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
];
const isHistoryRead = (url: string): boolean => url === `${AG_UI_PATH}/threads/thread/messages`;
const approval = {
  id: 'approval:native-1:call-refund',
  reason: 'tool-approval',
  toolCallId: 'call-refund',
  message: 'Refund the order?',
};
const approvalMetadata = { '@lostgradient/bureau': { runId: 'native-1' } };
const parkedApprovalEvents = [
  { ...started, metadata: approvalMetadata },
  { type: 'TOOL_CALL_START', toolCallId: 'call-refund', toolCallName: 'issue-refund' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'call-refund', delta: '{}' },
  { type: 'TOOL_CALL_END', toolCallId: 'call-refund' },
  {
    type: 'TOOL_CALL_RESULT',
    messageId: 'result-1',
    toolCallId: 'call-refund',
    content: 'requires approval',
    role: 'tool',
  },
  {
    ...finished,
    outcome: { type: 'interrupt', interrupts: [approval] },
    metadata: approvalMetadata,
  },
];

function acceptQueuedInput(text: string) {
  let inputId: string | undefined;
  const restore = installFetchImplementation(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON-RPC request body');
    const body = JSON.parse(init.body) as {
      method: string;
      params: { contextId: string; input: { id: string; payload: unknown } };
    };
    expect(body.method).toBe('bureau.contexts.input');
    expect(body.params).toMatchObject({ contextId: 'thread', input: { payload: text } });
    inputId = body.params.input.id;
    return Response.json({
      jsonrpc: '2.0',
      id: body.method,
      result: { outcome: 'admitted', receipt: { id: inputId, state: 'queued' } },
    });
  });
  return {
    restore,
    get inputId() {
      return inputId;
    },
  };
}

test('an opener’s transport is active from its request until its turn ends', async () => {
  const response = Promise.withResolvers<Response>();
  let posted = false;
  const session = open(async (_input, init) => {
    if (init?.method !== 'POST') return new Response('', { status: 404 });
    posted = true;
    return response.promise;
  });
  expect(session.transportActive).toBe(false);

  const sending = session.send('Hello');
  await waitUntil(() => posted, { message: 'the opener was posted' });

  // Nothing is attaching: the controller's own turn is what holds the transport.
  expect(session.attaching).toBe(false);
  expect(session.transportActive).toBe(true);
  response.resolve(sse([started, ...reply, finished]));
  await sending;
  expect(session.transportActive).toBe(false);
});

test('a new chat reads no history before its first run begins, and reads it once it has', async () => {
  const requests: string[] = [];
  const session = open(
    async (input, init) => {
      const url = urlOf(input);
      requests.push(url);
      if (url === `${AG_UI_PATH}/threads/thread/run`)
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      if (init?.method === 'POST') return sse([started, ...reply, finished]);
      return new Response('', { status: 404 });
    },
    { unopened: true },
  );

  // Before anything is sent: a refresh reads nothing, and a recovery attaches without a history read.
  expect(await session.refresh()).toBe(false);
  expect(requests).toEqual([]);
  expect(await session.reconnect()).toBe(false);
  expect(requests).toEqual([`${AG_UI_PATH}/threads/thread/run`]);

  await session.send('Hello');
  expect(requests.some(isHistoryRead)).toBe(false);
  expect(requests.filter((url) => url === `${AG_UI_PATH}/agents/assistant/run`)).toHaveLength(1);

  // The run's start kept the thread, so an idle refresh reads it now.
  await session.refresh().catch(() => false);
  expect(requests.some(isHistoryRead)).toBe(true);
});

test('a chat that names an existing thread reads its history when nothing is going', async () => {
  const requests: string[] = [];
  const session = open(async (input) => {
    const url = urlOf(input);
    requests.push(url);
    if (url === `${AG_UI_PATH}/threads/thread/run`)
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    return new Response('', { status: 404 });
  });

  await session.attach();

  expect(requests.some(isHistoryRead)).toBe(true);
});

test('a refresh whose read a whole turn began and ended inside keeps the message that turn sent', async () => {
  // COR-2412: the refresh after an approval's run stopped read the thread while the follow-up from
  // Up next was sent and stopped on its own approval; the stale read replaced the follow-up's row.
  const staleHistory = Promise.withResolvers<Response>();
  let historyRequested = false;
  const session = open(async (input, init) => {
    const url = urlOf(input);
    if (isHistoryRead(url)) {
      historyRequested = true;
      return staleHistory.promise;
    }
    // The attach after a refresh joins the waiting run from its cursor: no messages snapshot.
    if (url === `${AG_UI_PATH}/threads/thread/run`)
      return sse([started, { type: 'STATE_SNAPSHOT', snapshot: {} }, finished]);
    if (init?.method === 'POST') return sse([started, ...reply, finished]);
    return new Response('', { status: 404 });
  });

  const refreshing = session.refresh().catch(() => false);
  await waitUntil(() => historyRequested, { message: 'the refresh read the thread' });
  await session.send('And one more thing');
  expect(session.streaming).toBe(false);

  staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));
  expect(await refreshing).toBe(false);

  const texts = session.conversation.ids.map((id) =>
    JSON.stringify(session.conversation.messages[id]?.content ?? ''),
  );
  expect(texts.some((text) => text.includes('And one more thing'))).toBe(true);
});

test('a refresh discarded after a follow-up repairs the transcript once the turn is idle', async () => {
  const staleHistory = Promise.withResolvers<Response>();
  let historyReads = 0;
  const session = open(async (input, init) => {
    const url = urlOf(input);
    if (isHistoryRead(url)) {
      historyReads += 1;
      if (historyReads === 1) return staleHistory.promise;
      return Response.json({
        threadId: 'thread',
        messages: [{ id: 'decision', role: 'assistant', content: 'stored decision' }],
      });
    }
    if (url === `${AG_UI_PATH}/threads/thread/run`)
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    if (init?.method === 'POST') return sse([started, ...reply, finished]);
    return new Response('', { status: 404 });
  });

  const refreshing = session.refresh();
  await waitUntil(() => historyReads === 1, { message: 'the stale refresh read the thread' });
  await session.send('Follow-up while rereading');
  staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));

  expect(await refreshing).toBe(false);
  expect(historyReads).toBe(2);
  await waitUntil(() => session.conversation.ids.includes('decision'), {
    message: 'the discarded refresh repaired the transcript',
  });
});

test('a refresh discarded during a running follow-up repairs after the turn settles', async () => {
  const staleHistory = Promise.withResolvers<Response>();
  let historyReads = 0;
  let finishFollowUp: (() => void) | undefined;
  const session = open(async (input, init) => {
    const url = urlOf(input);
    if (isHistoryRead(url)) {
      historyReads += 1;
      if (historyReads === 1) return staleHistory.promise;
      return Response.json({
        threadId: 'thread',
        messages: [{ id: 'decision', role: 'assistant', content: 'stored decision' }],
      });
    }
    if (url === `${AG_UI_PATH}/threads/thread/run`)
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    if (url === `${AG_UI_PATH}/agents/assistant/run` && init?.method === 'POST') {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoded({
                ...started,
                metadata: { '@lostgradient/bureau': { runId: 'native-1' } },
              }),
            );
            finishFollowUp = () => {
              finishFollowUp = undefined;
              for (const event of [...reply, finished]) controller.enqueue(encoded(event));
              controller.close();
            };
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response('', { status: 404 });
  });

  const refreshing = session.refresh();
  await waitUntil(() => historyReads === 1, { message: 'the refresh read the thread' });
  const sending = session.send('Follow-up still running');
  try {
    await waitUntil(() => session.streaming && finishFollowUp !== undefined, {
      message: 'the follow-up is streaming',
    });
    staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));
    expect(await refreshing).toBe(false);
    expect(historyReads).toBe(1);
    finishFollowUp?.();
    await sending;
    expect(historyReads).toBeGreaterThanOrEqual(2);
  } finally {
    staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));
    finishFollowUp?.();
    await Promise.allSettled([refreshing, sending]);
  }
});

test('a parked approval accepts follow-up input without starting a turn or losing it to a stale refresh', async () => {
  const staleHistory = Promise.withResolvers<Response>();
  const queuedText = 'Keep this with the parked approval';
  let historyReads = 0;
  let newTurns = 0;
  const accepted = acceptQueuedInput(queuedText);
  try {
    const session = open(async (input, init) => {
      const url = urlOf(input);
      if (isHistoryRead(url)) {
        historyReads += 1;
        if (historyReads === 1) return staleHistory.promise;
        return Response.json({
          threadId: 'thread',
          messages:
            accepted.inputId === undefined
              ? []
              : [
                  {
                    id: accepted.inputId,
                    role: 'user',
                    content: queuedText,
                    metadata: { _deliveryStatus: 'queued' },
                  },
                ],
        });
      }
      if (url === `${AG_UI_PATH}/threads/thread/run`)
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      if (url === `${AG_UI_PATH}/agents/assistant/run` && init?.method === 'POST') {
        newTurns += 1;
        return sse(parkedApprovalEvents);
      }
      return new Response('', { status: 404 });
    });

    await session.send('Refund the order');
    expect(session.streaming).toBe(false);
    expect(session.approvals).toHaveLength(1);

    const refreshing = session.refresh();
    await waitUntil(() => historyReads === 1, {
      message: 'the parked thread history was requested',
    });
    await session.adapter.sendRunInput?.('thread', { role: 'user', content: queuedText }, []);
    const inputId = accepted.inputId;
    if (inputId === undefined) throw new Error('The parked input was never accepted');
    expect(session.streaming).toBe(false);
    expect(newTurns).toBe(1);
    expect(session.queuedFollowUps).toBe(1);
    staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));
    expect(await refreshing).toBe(false);
    expect(session.conversation.ids).toContain(inputId);
    await waitUntil(() => historyReads >= 2, { message: 'the parked thread history was repaired' });
  } finally {
    staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));
    accepted.restore();
  }
});

test('Up next drains a parked input when the resumed run reports that it took the input', async () => {
  const text = 'Deliver this after the approval';
  const accepted = acceptQueuedInput(text);
  let posts = 0;
  const session = open(async (input, init) => {
    if (urlOf(input) !== `${AG_UI_PATH}/agents/assistant/run` || init?.method !== 'POST')
      return new Response('', { status: 404 });
    posts += 1;
    if (posts === 1) return sse(parkedApprovalEvents);
    if (typeof init.body !== 'string') throw new Error('Expected an AG-UI resume body');
    const body = JSON.parse(init.body) as { resume?: unknown };
    expect(body.resume).toMatchObject([{ interruptId: approval.id }]);
    return sse([
      { ...started, metadata: approvalMetadata },
      {
        type: 'CUSTOM',
        name: 'bureau.inputs-delivered',
        value: { inputIds: [accepted.inputId] },
      },
      ...reply,
      { ...finished, metadata: approvalMetadata },
    ]);
  });

  try {
    await session.send('Refund the order');
    await session.adapter.sendRunInput?.('thread', { role: 'user', content: text }, []);
    expect(accepted.inputId).toBeDefined();
    expect(posts).toBe(1);
    expect(session.queuedFollowUps).toBe(1);
    await session.adapter.resolveToolApproval?.(approval.toolCallId, {
      decision: 'approve',
      remember: false,
    });
    expect(posts).toBe(2);
    expect(session.queuedFollowUps).toBe(0);
    expect(session.conversation.ids.filter((id) => id === accepted.inputId)).toHaveLength(1);
  } finally {
    accepted.restore();
  }
});

test('a live history snapshot cannot discard accepted input it does not carry', async () => {
  const text = 'Keep this queued input';
  const accepted = acceptQueuedInput(text);
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({ start: (controller) => (stream = controller) }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const session = open(async (input, init) =>
    urlOf(input) === `${AG_UI_PATH}/agents/assistant/run` && init?.method === 'POST'
      ? response
      : new Response('', { status: 404 }),
  );
  const sending = session.send('Start');
  const refreshed = { id: 'server-reply', role: 'assistant', content: 'A durable reply' };
  try {
    stream?.enqueue(encoded(started));
    for (const event of reply) stream?.enqueue(encoded(event));
    await waitUntil(() => session.conversation.ids.includes('reply'), {
      message: 'the run streamed its first reply',
    });
    await session.adapter.sendRunInput?.('thread', { role: 'user', content: text }, []);
    const inputId = accepted.inputId;
    if (inputId === undefined) throw new Error('The queued input was never accepted');
    expect(session.conversation.ids).toContain(inputId);
    stream?.enqueue(encoded({ type: 'MESSAGES_SNAPSHOT', messages: [refreshed] }));
    await waitUntil(() => session.conversation.ids.includes(refreshed.id), {
      message: 'the live snapshot supplied the durable reply',
    });
    expect(session.conversation.ids).toContain(inputId);
    expect(session.queuedFollowUps).toBe(1);

    const nextReply = { ...refreshed, id: 'next-reply' };
    stream?.enqueue(
      encoded({
        type: 'MESSAGES_SNAPSHOT',
        messages: [{ id: inputId, role: 'user', content: text }, nextReply],
      }),
    );
    await waitUntil(() => session.conversation.ids.includes(nextReply.id), {
      message: 'the next snapshot named the queued input',
    });
    expect(session.conversation.ids).toEqual([inputId, nextReply.id]);
    expect(session.queuedFollowUps).toBe(1);
  } finally {
    try {
      const inputId = accepted.inputId;
      if (inputId !== undefined) {
        stream?.enqueue(
          encoded({
            type: 'MESSAGES_SNAPSHOT',
            messages: [refreshed, { id: inputId, role: 'user', content: text }],
          }),
        );
      }
      stream?.enqueue(encoded(finished));
      stream?.close();
      await sending;
    } finally {
      accepted.restore();
    }
  }
});

test('Retry is unavailable while attach holds a history read, and that read cannot replace an accepted row', async () => {
  const staleHistory = Promise.withResolvers<Response>();
  let historyReads = 0;
  const session = open(async (input) => {
    const url = urlOf(input);
    if (url === `${AG_UI_PATH}/threads/thread/run`)
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    if (isHistoryRead(url)) {
      historyReads += 1;
      return historyReads === 1
        ? staleHistory.promise
        : Response.json({ threadId: 'thread', messages: [] });
    }
    return new Response('', { status: 404 });
  });

  const attaching = session.attach();
  await waitUntil(() => historyReads === 1, { message: 'the attach history read the thread' });
  // Probe outcome: the Retry control cannot be clicked while attach owns the transcript.
  expect(session.canRetryTurn).toBe(false);
  const next = appendMessages(session.conversation, { role: 'user', content: 'Retry row' });
  const rowId = next.ids.at(-1);
  if (rowId === undefined) throw new Error('The transcript row was never appended');
  expect(session.controller.adoptHistory(next, session.controller.captureHistoryToken())).toBe(
    true,
  );
  staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));

  expect(await attaching).toBe(false);
  expect(session.conversation.ids).toContain(rowId);
});

test('a Stop reconnect history read cannot replace a message sent after cancellation', async () => {
  const staleHistory = Promise.withResolvers<Response>();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let canceled = false;
  let historyReads = 0;
  let storedMessages: unknown[] = [];
  const session = open(async (input, init) => {
    const url = urlOf(input);
    if (url === `${AG_UI_PATH}/threads/thread/run`) {
      if (canceled) return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(
              encoded({ ...started, metadata: { '@lostgradient/bureau': { runId: 'native-1' } } }),
            );
            controller.enqueue(encoded({ type: 'STATE_SNAPSHOT', snapshot: {} }));
            controller.enqueue(encoded({ type: 'STEP_STARTED', stepName: 'step-0' }, 'cursor-1'));
          },
        }),
      );
    }
    if (url === `${AG_UI_PATH}/runs/native-1/cancel`) {
      canceled = true;
      return new Response('{}', { status: 202 });
    }
    if (isHistoryRead(url)) {
      historyReads += 1;
      return historyReads === 1
        ? staleHistory.promise
        : Response.json({ threadId: 'thread', messages: storedMessages });
    }
    if (url === `${AG_UI_PATH}/agents/assistant/run` && init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Expected an AG-UI run body');
      const body = JSON.parse(init.body) as { messages: unknown[] };
      storedMessages = body.messages;
      return sse([started, ...reply, finished]);
    }
    return new Response('', { status: 404 });
  });

  await session.attach();
  await waitUntil(() => session.streaming, { message: 'the session attached to the dropped run' });
  stream!.error(new TypeError('drop'));
  await waitUntil(() => session.reconnectAttempt === 1, {
    message: 'the session began reconnecting',
  });

  const stopping = session.adapter.stopGenerating?.('row');
  await waitUntil(() => historyReads === 1, { message: 'Stop read the cancelled thread' });
  await session.send('Sent after Stop');
  staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));
  await stopping;

  const texts = session.conversation.ids.map((id) =>
    JSON.stringify(session.conversation.messages[id]?.content ?? ''),
  );
  expect(texts.some((text) => text.includes('Sent after Stop'))).toBe(true);
  await waitUntil(() => historyReads >= 2, { message: 'the discarded Stop read was repaired' });
});
