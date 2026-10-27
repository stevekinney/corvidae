import { rejectionOf } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { settle } from '../../lib/fake-timers.test-support.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

const sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const open = (fetch: Fetcher) => {
  const session = new ChatSessionState({
    sessionId: 'thread',
    agentName: () => 'assistant',
    fetch,
  });
  sessions.push(session);
  return session;
};
const encoded = (event: unknown, id?: string) =>
  new TextEncoder().encode(
    `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`,
  );
const started = { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' };
const state = { type: 'STATE_SNAPSHOT', snapshot: {} };

test('retries exponential delays through eight consecutive failures and caps the delay', async () => {
  jest.useFakeTimers();
  const scheduled = spyOn(globalThis, 'setTimeout');
  let calls = 0;
  const session = open(async () => {
    calls += 1;
    throw new TypeError('offline');
  });
  expect(await session.attach()).toBe(false);
  expect(calls).toBe(1);
  for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
    expect(scheduled.mock.calls.at(-1)?.[1]).toBe(delay);
    const before = calls;
    jest.runOnlyPendingTimers();
    await settle();
    expect(calls).toBe(before + 1);
  }
  expect(calls).toBe(8);
  jest.advanceTimersByTime(60000);
  await settle();
  expect(calls).toBe(8);
});

test.each([403, 404, 410])('does not retry HTTP %s', async (status) => {
  jest.useFakeTimers();
  let calls = 0;
  const session = open(async () => {
    calls += 1;
    return new Response('', { status });
  });
  expect(await session.attach()).toBe(false);
  jest.advanceTimersByTime(60000);
  await settle();
  expect(calls).toBe(1);
});

test('manual reconnect and disposal invalidate pending retry timers', async () => {
  jest.useFakeTimers();
  let calls = 0;
  const session = open(async () => {
    calls += 1;
    throw new TypeError('offline');
  });
  await session.attach();
  jest.advanceTimersByTime(250);
  await settle();
  await session.reconnect();
  expect(calls).toBe(2);
  jest.advanceTimersByTime(250);
  await settle();
  expect(calls).toBe(2);
  session.dispose();
  jest.advanceTimersByTime(60000);
  await settle();
  expect(calls).toBe(2);
});

test('a received frame resets consecutive failures and the resumed request uses its real cursor', async () => {
  jest.useFakeTimers();
  const scheduled = spyOn(globalThis, 'setTimeout');
  let calls = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cursors: Array<string | null> = [];
  const session = open(async (_input, init) => {
    calls += 1;
    cursors.push(new Headers(init?.headers).get('Last-Event-ID'));
    if (calls < 3) throw new TypeError('offline');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(encoded(started));
          controller.enqueue(encoded(state));
          controller.enqueue(
            encoded({ type: 'STEP_STARTED', stepName: 'step-0' }, 'actual-cursor'),
          );
        },
      }),
    );
  });
  await session.attach();
  jest.runOnlyPendingTimers();
  await settle();
  jest.runOnlyPendingTimers();
  await settle();
  await waitUntil(() => session.streaming, { message: 'attached stream' });
  stream!.error(new TypeError('drop'));
  await settle();
  expect(scheduled.mock.calls.at(-1)?.[1]).toBe(500);
  expect(calls).toBe(3);
  jest.runOnlyPendingTimers();
  await settle();
  expect(calls).toBe(4);
  expect(cursors[3]).toBe('actual-cursor');
});

test('a stale opening cannot restore the transcript after a manual reconnect', async () => {
  let first: ((response: Response) => void) | undefined;
  let calls = 0;
  const session = open(async () => {
    calls += 1;
    if (calls === 1)
      return new Promise<Response>((resolve) => {
        first = resolve;
      });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded(started));
          controller.enqueue(
            encoded({
              type: 'MESSAGES_SNAPSHOT',
              messages: [{ id: 'fresh', role: 'user', content: 'fresh' }],
            }),
          );
        },
      }),
    );
  });
  const old = session.attach();
  await session.reconnect();
  first!(
    new Response(
      [
        started,
        { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'stale', role: 'user', content: 'stale' }] },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    ),
  );
  await old;
  expect(session.conversation.ids).toContain('fresh');
  expect(session.conversation.ids).not.toContain('stale');
});

test('even one opening frame resets failures before a drop awaiting the snapshot', async () => {
  jest.useFakeTimers();
  const scheduled = spyOn(globalThis, 'setTimeout');
  let calls = 0;
  let fail: (() => void) | undefined;
  const session = open(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('offline');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded(started));
          fail = () => controller.error(new TypeError('drop before snapshot'));
        },
      }),
    );
  });
  await session.attach();
  jest.runOnlyPendingTimers();
  await settle();
  fail!();
  await settle();
  expect(scheduled.mock.calls.at(-1)?.[1]).toBe(500);
});

test('disposal fences a late opening reader as well as its timers', async () => {
  const response = Promise.withResolvers<Response>();
  const session = open(async () => response.promise);
  const attaching = session.attach();
  session.dispose();
  response.resolve(
    new Response(
      [
        started,
        { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'late', role: 'user', content: 'late' }] },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    ),
  );
  expect(await attaching).toBe(false);
  expect(session.conversation.ids).toEqual([]);
});

for (const recovery of ['suffix', 'snapshot', 'other-run'] as const) {
  test(`asset announcements survive rollback only for same-run suffix recovery: ${recovery}`, async () => {
    jest.useFakeTimers();
    const native = (runId: string, wireId: string) => ({
      ...started,
      runId: wireId,
      metadata: { '@lostgradient/bureau': { runId } },
    });
    const response = (events: Array<{ event: unknown; id?: string }>) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const { event, id } of events) controller.enqueue(encoded(event, id));
            controller.close();
          },
        }),
      );
    let calls = 0;
    const cursors: Array<string | null> = [];
    const session = open(async (_input, init) => {
      calls += 1;
      cursors.push(new Headers(init?.headers).get('Last-Event-ID'));
      if (calls === 1)
        return response([
          { event: native('native-1', 'wire-1') },
          { event: { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId: 'reply' } },
          { event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Here.' } },
          {
            event: {
              type: 'CUSTOM',
              name: 'bureau.asset-part',
              value: { messageId: 'reply', index: 0, assetId: 'asset-a', mediaType: 'image/png' },
            },
            id: 'asset-cursor',
          },
        ]);
      const opening =
        recovery === 'snapshot'
          ? [
              {
                event: {
                  type: 'MESSAGES_SNAPSHOT',
                  messages: [{ id: 'reply', role: 'assistant', content: 'Here.' }],
                },
              },
            ]
          : [{ event: state }];
      const text =
        recovery === 'other-run'
          ? [
              { event: { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId: 'reply' } },
              { event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'New.' } },
            ]
          : [];
      return response([
        { event: native(recovery === 'other-run' ? 'native-2' : 'native-1', 'wire-2') },
        ...opening,
        ...text,
        ...(recovery === 'snapshot'
          ? []
          : [{ event: { type: 'TEXT_MESSAGE_END', messageId: 'reply' } }]),
        { event: { type: 'RUN_FINISHED', threadId: 'thread', runId: 'wire-2' } },
      ]);
    });
    expect(
      await rejectionOf(session.adapter.sendMessage({ role: 'user', content: 'Draw it' }, [])),
    ).toBeInstanceOf(Error);
    expect(session.conversation.messages['reply']).toBeUndefined();
    expect(await session.reconnect()).toBe(true);
    await waitUntil(() => !session.streaming, { message: 'resumed terminal' });
    expect(cursors[1]).toBe('asset-cursor');
    expect(session.failure).toBeUndefined();
    const row = session.conversation.messages['reply'];
    expect(row?.content).toBe(recovery === 'other-run' ? 'New.' : 'Here.');
    expect(row?.metadata?.['bureau:assetParts']).toEqual(
      recovery === 'suffix'
        ? [{ index: 0, assetId: 'asset-a', mediaType: 'image/png' }]
        : undefined,
    );
  });
}
