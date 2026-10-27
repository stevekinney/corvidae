import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
import { createReplayAwareClosableIterable } from '../operations/event-stream-contracts.ts';
import { DEFAULT_MAX_STREAM_DURATION_MS } from './operation-handler-subscription.ts';
import {
  createManualScheduler,
  createTestHost,
  eventsOperation,
  eventStreamRequest,
  readerContext,
  readFrames,
  scopedEchoOperation,
  statusOf,
  strangerContext,
  type TestEvent,
} from './operation-handler.test-support.ts';
import { createOperationHandler } from './operation-handler.ts';

function setup(
  extra: Partial<
    Parameters<typeof createOperationHandler<ReturnType<typeof createTestHost>>>[0]
  > = {},
) {
  const host = createTestHost();
  const handler = createOperationHandler({
    operations: [eventsOperation, scopedEchoOperation],
    host,
    authenticate: async () => readerContext(),
    ...extra,
  });
  return { host, handler };
}

function frameData(frame: string): Record<string, unknown> {
  const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
  return JSON.parse(line?.slice('data: '.length) ?? 'null') as Record<string, unknown>;
}

describe('GET /v1/subscriptions/:operationName', () => {
  it('replays what already happened, then follows live, with no Engine', async () => {
    const { host, handler } = setup();
    host.feed.publish('first');
    host.feed.publish('second');

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.events'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const replayed = await readFrames(reader, 2);
    host.feed.publish('third');
    const live = await readFrames(reader, 1);
    await reader.cancel();

    expect(replayed.map((frame) => frameData(frame)['kind'])).toEqual(['first', 'second']);
    expect(replayed[0]).toContain('id: 1\nevent: first\n');
    expect(frameData(live[0] ?? '')['kind']).toBe('third');
    expect(host.closed.count).toBe(1);
  });

  it('resumes after Last-Event-ID', async () => {
    const { host, handler } = setup();
    for (const kind of ['a', 'b', 'c']) host.feed.publish(kind);

    const response = await handler(
      eventStreamRequest('/v1/subscriptions/probe.events', { 'Last-Event-ID': '2' }),
    );
    const reader = response.body!.getReader();
    const frames = await readFrames(reader, 1);
    await reader.cancel();

    expect(frameData(frames[0] ?? '')['kind']).toBe('c');
  });

  it('lets Last-Event-ID override a query fromCursor', async () => {
    const { host, handler } = setup();
    for (const kind of ['a', 'b', 'c']) host.feed.publish(kind);

    const response = await handler(
      eventStreamRequest('/v1/subscriptions/probe.events?fromCursor=0', { 'Last-Event-ID': '2' }),
    );
    const reader = response.body!.getReader();
    await readFrames(reader, 1);
    await reader.cancel();

    expect(host.seenInputs).toEqual([{ fromCursor: '2' }]);
  });

  it('maps a single query key to a string and coerces nothing', async () => {
    const { host, handler } = setup();

    const response = await handler(
      eventStreamRequest('/v1/subscriptions/probe.events?topic=billing&fromCursor=5'),
    );
    await response.body!.cancel();

    expect(host.seenInputs).toEqual([{ topic: 'billing', fromCursor: '5' }]);
  });

  it('maps a repeated query key to an array of strings in order', async () => {
    const { host, handler } = setup();

    const response = await handler(
      eventStreamRequest('/v1/subscriptions/probe.events?kinds=b&kinds=a&kinds=c'),
    );
    await response.body!.cancel();

    expect(host.seenInputs).toEqual([{ kinds: ['b', 'a', 'c'] }]);
  });

  it('rejects an unknown query key under unknownKeyPolicy.http: reject', async () => {
    const { handler } = setup();

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.events?surprise=1'));

    expect(response.status).toBe(400);
  });

  it('strips an unknown query key under unknownKeyPolicy.http: strip', async () => {
    const host = createTestHost();
    const lenient = defineOperation<
      typeof eventsOperation.inputSchema,
      typeof eventsOperation.outputSchema,
      typeof eventsOperation.eventSchema,
      typeof host
    >({
      ...eventsOperation,
      name: 'probe.lenient',
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    });
    const handler = createOperationHandler({
      operations: [lenient],
      host,
      authenticate: async () => readerContext(),
    });

    const response = await handler(
      eventStreamRequest('/v1/subscriptions/probe.lenient?topic=x&surprise=1&__proto__=y'),
    );
    await response.body!.cancel();

    expect(response.status).toBe(200);
    expect(host.seenInputs).toEqual([{ topic: 'x' }]);
  });

  it('answers 406 when the request does not accept text/event-stream', async () => {
    const { handler } = setup();

    const response = await handler(
      new Request('http://localhost/v1/subscriptions/probe.events', {
        headers: { Accept: 'application/json' },
      }),
    );

    expect(response.status).toBe(406);
  });

  it('answers 405 to a method other than GET', async () => {
    const { handler } = setup();

    const response = await handler(
      new Request('http://localhost/v1/subscriptions/probe.events', {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('answers 404 for an unknown operation and for a missing name', async () => {
    const { handler } = setup();

    const status = (path: string) => statusOf(handler, eventStreamRequest(path));

    expect(await status('/v1/subscriptions/probe.nothing')).toBe(404);
    expect(await status('/v1/subscriptions')).toBe(404);
    expect(await status('/v1/subscriptions/a/b')).toBe(404);
    expect(await status('/v1/subscriptions/%E0%A4%A')).toBe(400);
  });

  it('refuses an operation that is not a subscription', async () => {
    const { handler } = setup();

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.scoped'));

    expect(response.status).toBe(422);
  });

  it('refuses a subscription that does not declare transports.http', async () => {
    const host = createTestHost();
    const socketOnly = defineOperation<
      typeof eventsOperation.inputSchema,
      typeof eventsOperation.outputSchema,
      typeof eventsOperation.eventSchema,
      typeof host
    >({
      ...eventsOperation,
      name: 'probe.socket',
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
    });
    const handler = createOperationHandler({
      operations: [socketOnly],
      host,
      authenticate: async () => readerContext(),
    });

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.socket'));

    expect(response.status).toBe(501);
    expect(host.seenInputs).toEqual([]);
  });

  it('denies a caller who lacks the operation scope', async () => {
    const { host, handler } = setup({ authenticate: async () => strangerContext() });

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.events'));

    expect(response.status).toBe(403);
    expect(host.seenInputs).toEqual([]);
  });

  it('answers 401 to an anonymous caller when no authenticate is configured', async () => {
    const host = createTestHost();
    const handler = createOperationHandler({ operations: [eventsOperation], host });

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.events'));

    expect(response.status).toBe(401);
  });

  it('ends the stream with an error frame when an element carries no cursor', async () => {
    const host = createTestHost();
    const malformed = defineOperation<
      typeof eventsOperation.inputSchema,
      typeof eventsOperation.outputSchema,
      z.ZodObject<{ value: z.ZodString }>,
      typeof host
    >({
      ...eventsOperation,
      name: 'probe.malformed',
      eventSchema: z.object({ value: z.string() }),
      invoke: async () => ({
        envelope: { subscriptionId: 'sub_1', cursor: '0' },
        iterable: (async function* () {
          yield { value: 'no cursor' };
        })(),
        close: async () => {
          host.closed.count += 1;
        },
      }),
    });
    const handler = createOperationHandler({
      operations: [malformed],
      host,
      authenticate: async () => readerContext(),
    });

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.malformed'));
    const body = await response.text();

    expect(body).toContain('event: error');
    expect(body).toContain('Internal server error');
    expect(body).not.toContain('no cursor');
    expect(host.closed.count).toBe(1);
  });

  it('refuses an element whose cursor or kind would forge an SSE field', async () => {
    const host = createTestHost();
    const hostile = (name: string, element: { kind: string; cursor: string }) =>
      defineOperation<
        typeof eventsOperation.inputSchema,
        typeof eventsOperation.outputSchema,
        typeof eventsOperation.eventSchema,
        typeof host
      >({
        ...eventsOperation,
        name,
        invoke: async () => ({
          envelope: { subscriptionId: 'sub_1', cursor: '0' },
          iterable: (async function* () {
            yield { ...element, emittedAtMs: 1, payload: {} };
          })(),
          close: async () => {
            host.closed.count += 1;
          },
        }),
      });
    const handler = createOperationHandler({
      operations: [
        hostile('probe.hostile.cursor', { kind: 'ok', cursor: '1\nevent: error' }),
        hostile('probe.hostile.kind', { kind: 'ok\r\nid: 99', cursor: '1' }),
      ],
      host,
      authenticate: async () => readerContext(),
    });

    for (const name of ['probe.hostile.cursor', 'probe.hostile.kind']) {
      const response = await handler(eventStreamRequest(`/v1/subscriptions/${name}`));
      const body = await response.text();

      expect(body).toBe(
        'event: error\ndata: {"code":"EngineFailure","message":"Internal server error"}\n\n',
      );
    }
    expect(host.closed.count).toBe(2);
  });

  it('releases the subscription when the client disconnects', async () => {
    const { host, handler } = setup();
    host.feed.publish('only');
    const disconnect = new AbortController();

    const response = await handler(
      new Request('http://localhost/v1/subscriptions/probe.events', {
        headers: { Accept: 'text/event-stream' },
        signal: disconnect.signal,
      }),
    );
    const reader = response.body!.getReader();
    await readFrames(reader, 1);
    expect(host.closed.count).toBe(0);

    disconnect.abort();
    // load-proof: abort() runs its listeners synchronously and the close handler settles in the promise chain, so a microtask drain observes the close
    await Bun.sleep(0);

    expect(host.closed.count).toBe(1);
    await reader.cancel();
  });

  it('marks the end of the replay with a ping when the operation reports it', async () => {
    const host = createTestHost();
    const replayAware = defineOperation<
      typeof eventsOperation.inputSchema,
      typeof eventsOperation.outputSchema,
      typeof eventsOperation.eventSchema,
      typeof host
    >({
      ...eventsOperation,
      name: 'probe.replayaware',
      invoke: async ({ input }) => {
        const controller = new AbortController();
        const iterable = createReplayAwareClosableIterable<TestEvent>(
          (onReplayComplete) => {
            queueMicrotask(onReplayComplete);
            return host.feed.subscribe(input.fromCursor, controller.signal);
          },
          { close: () => controller.abort() },
        );
        return {
          envelope: { subscriptionId: 'sub_1', cursor: '0' },
          iterable,
          close: () => iterable.close(),
        };
      },
    });
    host.feed.publish('first');
    const handler = createOperationHandler({
      operations: [replayAware],
      host,
      authenticate: async () => readerContext(),
    });

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.replayaware'));
    const reader = response.body!.getReader();
    const frames = await readFrames(reader, 2);
    await reader.cancel();

    const ping = frames.find((frame) => frame.startsWith('event: ping')) ?? '';
    expect(ping).toContain('"replayComplete":true');
    expect(ping).not.toContain('id:');
    expect(frames.some((frame) => frame.startsWith('id: 1\nevent: first'))).toBe(true);
  });
});

describe('construction', () => {
  it('refuses an http subscription whose input has no fromCursor', () => {
    const host = createTestHost();
    const noCursor = defineOperation<
      z.ZodObject<{ topic: z.ZodOptional<z.ZodString> }>,
      typeof eventsOperation.outputSchema,
      typeof eventsOperation.eventSchema,
      typeof host
    >({
      ...eventsOperation,
      name: 'probe.nocursor',
      inputSchema: z.object({ topic: z.string().optional() }),
    });

    expect(() => createOperationHandler({ operations: [noCursor], host })).toThrow(
      /subscription "probe\.nocursor".*no fromCursor/,
    );
  });

  it('accepts a subscription without fromCursor when it is not served over http', () => {
    const host = createTestHost();
    const socketOnly = defineOperation<
      z.ZodObject<{}>,
      typeof eventsOperation.outputSchema,
      typeof eventsOperation.eventSchema,
      typeof host
    >({
      ...eventsOperation,
      name: 'probe.socketonly',
      inputSchema: z.object({}),
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
    });

    expect(() => createOperationHandler({ operations: [socketOnly], host })).not.toThrow();
  });
});

describe('maxStreamDurationMs', () => {
  it('ends the response cleanly once the deadline fires, and releases the subscription', async () => {
    const clock = createManualScheduler();
    const { host, handler } = setup({
      maxStreamDurationMs: 60_000,
      heartbeat: { intervalMs: 15_000, schedule: clock.schedule, now: () => 0 },
    });
    host.feed.publish('only');

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.events'));
    const reader = response.body!.getReader();
    await readFrames(reader, 1);
    expect(clock.delays).toContain(60_000);

    clock.fire(60_000);
    const next = await reader.read();

    expect(next.done).toBe(true);
    expect(host.closed.count).toBe(1);
    expect(clock.cancelled(60_000)).toBe(1);
    expect(clock.cancelled(15_000)).toBe(1);
  });

  it('ends the response at the deadline even when the close hook never settles', async () => {
    const clock = createManualScheduler();
    const host = createTestHost();
    const stalled = defineOperation<
      typeof eventsOperation.inputSchema,
      typeof eventsOperation.outputSchema,
      typeof eventsOperation.eventSchema,
      typeof host
    >({
      ...eventsOperation,
      name: 'probe.stalled',
      invoke: async ({ input }) => ({
        envelope: { subscriptionId: 'sub_1', cursor: '0' },
        iterable: host.feed.subscribe(input.fromCursor, new AbortController().signal),
        close: () => new Promise<void>(() => undefined),
      }),
    });
    const handler = createOperationHandler({
      operations: [stalled],
      host,
      authenticate: async () => readerContext(),
      maxStreamDurationMs: 60_000,
      heartbeat: { intervalMs: 15_000, schedule: clock.schedule, now: () => 0 },
    });

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.stalled'));
    const reader = response.body!.getReader();
    clock.fire(60_000);
    const next = await reader.read();

    expect(next.done).toBe(true);
  });

  it('defaults to fifteen minutes', async () => {
    const clock = createManualScheduler();
    const { handler } = setup({
      heartbeat: { intervalMs: 15_000, schedule: clock.schedule, now: () => 0 },
    });

    const response = await handler(eventStreamRequest('/v1/subscriptions/probe.events'));
    await response.body!.cancel();

    expect(DEFAULT_MAX_STREAM_DURATION_MS).toBe(15 * 60 * 1000);
    expect(clock.delays).toContain(900_000);
  });

  it('does not bound a JSON-RPC response', async () => {
    const clock = createManualScheduler();
    const { handler } = setup({
      heartbeat: { intervalMs: 15_000, schedule: clock.schedule, now: () => 0 },
    });

    await handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'probe.scoped',
          params: { message: 'x' },
        }),
      }),
    );

    expect(clock.delays).toEqual([]);
  });

  it('is validated as a positive integer at construction', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() =>
        createOperationHandler({ operations: [], host: {}, maxStreamDurationMs: value }),
      ).toThrow(/maxStreamDurationMs/);
    }
  });

  it('accepts the largest delay a timer honors', () => {
    expect(() =>
      createOperationHandler({ operations: [], host: {}, maxStreamDurationMs: 2_147_483_647 }),
    ).not.toThrow();
  });
});
