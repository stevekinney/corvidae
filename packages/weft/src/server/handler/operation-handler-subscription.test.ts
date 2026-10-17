import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
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
        close: async () => undefined,
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
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createOperationHandler({ operations: [], host: {}, maxStreamDurationMs: value }),
      ).toThrow(/maxStreamDurationMs/);
    }
  });
});
