import { describe, expect, it } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';

import { fixtureHandler, watchJobs } from '../../scripts/operation-client-test-support.ts';
import {
  createTestHost,
  readerContext,
  type TestHost,
} from '../handler/operation-handler.test-support.ts';
import { createOperationHandler } from '../handler/operation-handler.ts';
import { defineOperation } from '../operation-registry.ts';
import { CatalogClientError, type CatalogFetch } from './catalog-client.ts';
import {
  sseSubscriptionTransport,
  subscriptionUrl,
  type SseSubscriptionConnection,
} from './sse-subscription-transport.ts';
import { createSubscriptionClient, type SubscriptionMessage } from './subscription-client.ts';

const BASE_URL = 'http://localhost';

/** A `fetch` that serves each request from the handler, with no network. */
function handlerFetch(handler: (request: Request) => Promise<Response>): CatalogFetch {
  return (input, init) => handler(new Request(input, init));
}

type Messages = AsyncIterator<SubscriptionMessage<unknown>>;

function open(
  handler: (request: Request) => Promise<Response>,
  input: unknown = {},
  options: Parameters<ReturnType<typeof sseSubscriptionTransport>>[2] = {},
  connection: Partial<SseSubscriptionConnection> = {},
): Messages {
  const transport = sseSubscriptionTransport({
    baseUrl: BASE_URL,
    fetch: handlerFetch(handler),
    ...connection,
  });
  return transport('probe.jobs.watch', input, options)[Symbol.asyncIterator]();
}

async function nextMessage(messages: Messages): Promise<SubscriptionMessage<unknown>> {
  const result = await messages.next();
  if (result.done === true) throw new Error('the stream ended');
  return result.value;
}

function eventSummary(message: SubscriptionMessage<unknown>): string {
  if (message.type === 'replay-complete') return 'replay-complete';
  const data = message.data as { kind: string };
  return `${message.id}:${data.kind}`;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('a subscription against the operation handler', () => {
  it('yields the events in order with their ids, then the replay-complete marker', async () => {
    const { host, handler } = fixtureHandler();
    for (const kind of ['first', 'second', 'third']) host.feed.publish(kind);
    const controller = new AbortController();
    const messages = open(handler, {}, { signal: controller.signal });

    const received: string[] = [];
    for (let count = 0; count < 4; count += 1) {
      received.push(eventSummary(await nextMessage(messages)));
    }
    controller.abort();

    expect(received).toEqual(['1:first', '2:second', '3:third', 'replay-complete']);
  });

  it('types each event as the whole envelope the operation emitted', async () => {
    const { host, handler } = fixtureHandler();
    host.feed.publish('first');
    const controller = new AbortController();
    const messages = open(handler, {}, { signal: controller.signal });

    const event = await nextMessage(messages);
    controller.abort();

    expect(event).toEqual({
      type: 'event',
      id: '1',
      data: { kind: 'first', cursor: '1', emittedAtMs: 1, payload: { kind: 'first' } },
    });
  });

  it('reads one multiline JSON event when a network chunk divides a CRLF', async () => {
    const encoder = new TextEncoder();
    const fetchStub: CatalogFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('id: 1\r\nevent: started\r\ndata: {"kind":"started",\r'),
            );
            controller.enqueue(encoder.encode('\ndata: "value":42}\r\n\r'));
            controller.enqueue(encoder.encode('\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const received: SubscriptionMessage<unknown>[] = [];
    const transport = sseSubscriptionTransport({ baseUrl: BASE_URL, fetch: fetchStub });
    for await (const message of transport('probe.jobs.watch', {})) received.push(message);

    expect(received).toEqual([{ type: 'event', id: '1', data: { kind: 'started', value: 42 } }]);
  });

  it('yields replay-complete once, then follows events published live', async () => {
    const { host, handler } = fixtureHandler();
    host.feed.publish('old');
    const controller = new AbortController();
    const messages = open(handler, {}, { signal: controller.signal });

    expect(eventSummary(await nextMessage(messages))).toBe('1:old');
    expect(await nextMessage(messages)).toEqual({ type: 'replay-complete' });
    host.feed.publish('live-one');
    host.feed.publish('live-two');
    const live = [
      eventSummary(await nextMessage(messages)),
      eventSummary(await nextMessage(messages)),
    ];
    controller.abort();

    expect(live).toEqual(['2:live-one', '3:live-two']);
  });

  it('never yields a second replay-complete when the server sends another ping', async () => {
    const pings =
      'event: ping\ndata: {"emittedAtMs":1,"replayComplete":true}\n\n' +
      'event: ping\ndata: {"emittedAtMs":2,"replayComplete":true}\n\n' +
      'event: ping\ndata: {"emittedAtMs":3}\n\n' +
      'id: 1\nevent: a\ndata: {"kind":"a"}\n\n';
    const fetchStub: CatalogFetch = async () =>
      new Response(pings, { headers: { 'content-type': 'text/event-stream' } });

    const received: string[] = [];
    for await (const message of sseSubscriptionTransport({ baseUrl: BASE_URL, fetch: fetchStub })(
      'probe.jobs.watch',
      {},
    )) {
      received.push(eventSummary(message));
    }

    expect(received).toEqual(['replay-complete', '1:a']);
  });

  it('resumes after the event lastEventId names', async () => {
    const { host, handler } = fixtureHandler();
    for (const kind of ['a', 'b', 'c', 'd']) host.feed.publish(kind);
    const controller = new AbortController();
    const messages = open(handler, {}, { signal: controller.signal, lastEventId: '2' });

    const received = [
      eventSummary(await nextMessage(messages)),
      eventSummary(await nextMessage(messages)),
    ];
    controller.abort();

    expect(received).toEqual(['3:c', '4:d']);
  });

  it('sends lastEventId as the Last-Event-ID header and asks for an event stream', async () => {
    const seen: Request[] = [];
    const fetchStub: CatalogFetch = async (input, init) => {
      seen.push(new Request(input, init));
      return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    };

    const transport = sseSubscriptionTransport({
      baseUrl: BASE_URL,
      headers: { authorization: 'Bearer token' },
      fetch: fetchStub,
    });
    for await (const message of transport(
      'probe.jobs.watch',
      { topic: 'jobs' },
      { lastEventId: '7' },
    )) {
      throw new Error(`unexpected ${message.type}`);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe('http://localhost/v1/subscriptions/probe.jobs.watch?topic=jobs');
    expect(seen[0]?.headers.get('last-event-id')).toBe('7');
    expect(seen[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer token');
  });

  it('ends the iteration without an error when the signal aborts', async () => {
    const { host, handler } = fixtureHandler();
    host.feed.publish('first');
    const controller = new AbortController();
    const messages = open(handler, {}, { signal: controller.signal });
    await nextMessage(messages);
    await nextMessage(messages);

    const pending = messages.next();
    controller.abort();

    expect(await pending).toEqual({ done: true, value: undefined });
    await waitUntil(() => host.closed.count === 1, { message: 'the subscription to close' });
  });

  it('yields nothing and sends nothing when the signal is already aborted', async () => {
    const seen: string[] = [];
    const fetchStub: CatalogFetch = async (input) => {
      seen.push(new Request(input).url);
      return new Response('');
    };
    const controller = new AbortController();
    controller.abort();

    const messages = sseSubscriptionTransport({ baseUrl: BASE_URL, fetch: fetchStub })(
      'probe.jobs.watch',
      {},
      { signal: controller.signal },
    );
    for await (const message of messages) throw new Error(`unexpected ${message.type}`);

    expect(seen).toEqual([]);
  });

  it('ends without an error when the signal aborts while the request is in flight', async () => {
    const controller = new AbortController();
    const hanging: CatalogFetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const messages = sseSubscriptionTransport({ baseUrl: BASE_URL, fetch: hanging })(
      'probe.jobs.watch',
      {},
      { signal: controller.signal },
    )[Symbol.asyncIterator]();

    const pending = messages.next();
    controller.abort(new Error('stopped'));

    expect(await pending).toEqual({ done: true, value: undefined });
  });

  it('closes the stream when the consumer leaves the loop early', async () => {
    const { host, handler } = fixtureHandler();
    host.feed.publish('first');
    host.feed.publish('second');
    const messages = open(handler);

    await nextMessage(messages);
    await messages.return?.();

    await waitUntil(() => host.closed.count === 1, { message: 'the subscription to close' });
  });

  it('opens nothing until the iteration starts', async () => {
    const seen: string[] = [];
    const fetchStub: CatalogFetch = async (input) => {
      seen.push(new Request(input).url);
      return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    };
    const client = createSubscriptionClient<{
      'probe.jobs.watch': { readonly input: {}; readonly event: unknown };
    }>(['probe.jobs.watch'], sseSubscriptionTransport({ baseUrl: BASE_URL, fetch: fetchStub }));

    const stream = client['probe.jobs.watch']({});
    expect(seen).toEqual([]);
    for await (const message of stream) throw new Error(`unexpected ${message.type}`);
    expect(seen).toHaveLength(1);
  });

  it("uses a call's own fetch and signal over the connection's", async () => {
    const connectionFetch: CatalogFetch = async () => {
      throw new Error('the connection fetch must not be used');
    };
    const seen: Array<AbortSignal | null | undefined> = [];
    const callFetch: CatalogFetch = async (_input, init) => {
      seen.push(init?.signal);
      return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    };
    const controller = new AbortController();

    const transport = sseSubscriptionTransport({ baseUrl: BASE_URL, fetch: connectionFetch });
    for await (const message of transport(
      'probe.jobs.watch',
      {},
      { fetch: callFetch, signal: controller.signal },
    )) {
      throw new Error(`unexpected ${message.type}`);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('a subscription that fails', () => {
  it('throws a CatalogClientError for an error frame', async () => {
    const host = createTestHost();
    const broken = defineOperation<
      typeof watchJobs.inputSchema,
      typeof watchJobs.outputSchema,
      typeof watchJobs.eventSchema,
      TestHost
    >({
      ...watchJobs,
      name: 'probe.jobs.broken',
      invoke: async () => ({
        subscriptionId: 'sub_1',
        envelope: { subscriptionId: 'sub_1', cursor: '0' },
        iterable: (async function* () {
          throw new Error('feed is down');
        })(),
        close: async () => undefined,
      }),
    });
    const handler = createOperationHandler({
      operations: [broken],
      host,
      authenticate: async () => readerContext(),
    });

    const caught = await rejectionOf(
      (async () => {
        for await (const message of sseSubscriptionTransport({
          baseUrl: BASE_URL,
          fetch: handlerFetch(handler),
        })('probe.jobs.broken', {})) {
          void message;
        }
      })(),
    );

    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.operationName).toBe('probe.jobs.broken');
    expect(error.message).toBe('Internal server error');
    expect(error.data).toEqual({ code: 'EngineFailure', data: undefined, retryable: false });
  });

  it('delivers the events before an error frame, then throws', async () => {
    const stream =
      'id: 1\nevent: a\ndata: {"kind":"a"}\n\n' +
      'event: error\ndata: {"code":"Unavailable","message":"feed down","data":{"retryAfterSeconds":1}}\n\n';
    const fetchStub: CatalogFetch = async () =>
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    const messages = sseSubscriptionTransport({ baseUrl: BASE_URL, fetch: fetchStub })(
      'probe.jobs.watch',
      {},
    )[Symbol.asyncIterator]();

    expect(eventSummary(await nextMessage(messages))).toBe('1:a');
    const caught = await rejectionOf(messages.next());

    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).message).toBe('feed down');
    expect((caught as CatalogClientError).data).toEqual({
      code: 'Unavailable',
      data: { retryAfterSeconds: 1 },
    });
  });

  it('keeps the retryable and remediation of an error frame in the error’s data', async () => {
    const stream =
      'event: error\ndata: {"code":"Unavailable","message":"feed down","data":{},"retryable":true,"remediation":"Follow the feed again."}\n\n';
    const fetchStub: CatalogFetch = async () =>
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    const messages = sseSubscriptionTransport({ baseUrl: BASE_URL, fetch: fetchStub })(
      'probe.jobs.watch',
      {},
    )[Symbol.asyncIterator]();

    const caught = await rejectionOf(messages.next());

    expect((caught as CatalogClientError).data).toEqual({
      code: 'Unavailable',
      data: {},
      retryable: true,
      remediation: 'Follow the feed again.',
    });
  });

  it('throws a CatalogClientError carrying the status of a response that is not a success', async () => {
    const { handler } = fixtureHandler();
    const transport = sseSubscriptionTransport({
      baseUrl: BASE_URL,
      fetch: handlerFetch(handler),
    });

    const caught = await rejectionOf(
      (async () => {
        for await (const message of transport('probe.jobs.nope', {})) void message;
      })(),
    );

    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.code).toBe(404);
    expect(error.operationName).toBe('probe.jobs.nope');
    expect(error.message).toBe('unknown operation: probe.jobs.nope');
  });

  it('names the status text when the failed response has no message', async () => {
    const fetchStub: CatalogFetch = async () =>
      new Response('upstream down', { status: 502, statusText: 'Bad Gateway' });

    const caught = await rejectionOf(
      (async () => {
        for await (const message of sseSubscriptionTransport({
          baseUrl: BASE_URL,
          fetch: fetchStub,
        })('probe.jobs.watch', {})) {
          void message;
        }
      })(),
    );

    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe(502);
    expect((caught as CatalogClientError).message).toBe('Bad Gateway');
  });

  it('throws a CatalogClientError for a response that is not an event stream', async () => {
    const fetchStub: CatalogFetch = async () => Response.json({ ok: true });

    const caught = await rejectionOf(
      (async () => {
        for await (const message of sseSubscriptionTransport({
          baseUrl: BASE_URL,
          fetch: fetchStub,
        })('probe.jobs.watch', {})) {
          void message;
        }
      })(),
    );

    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.code).toBe(200);
    expect(error.message).toContain('Expected an event stream for probe.jobs.watch');
    expect(error.message).toContain('application/json');
  });

  it('throws a CatalogClientError for an event whose data is not JSON', async () => {
    const fetchStub: CatalogFetch = async () =>
      new Response('id: 1\nevent: a\ndata: not json\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });

    const caught = await rejectionOf(
      (async () => {
        for await (const message of sseSubscriptionTransport({
          baseUrl: BASE_URL,
          fetch: fetchStub,
        })('probe.jobs.watch', {})) {
          void message;
        }
      })(),
    );

    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe(-32700);
  });

  it('rejects when the request itself fails and the caller did not abort', async () => {
    const fetchStub: CatalogFetch = async () => {
      throw new TypeError('network down');
    };
    const caught = await rejectionOf(
      (async () => {
        for await (const message of sseSubscriptionTransport({
          baseUrl: BASE_URL,
          fetch: fetchStub,
        })('probe.jobs.watch', {})) {
          void message;
        }
      })(),
    );
    expect(caught).toBeInstanceOf(TypeError);
  });
});

describe('subscriptionUrl', () => {
  it('joins the base, the route prefix and the encoded operation name', () => {
    expect(subscriptionUrl({ baseUrl: 'https://api.example.test/' }, 'probe.jobs.watch', {})).toBe(
      'https://api.example.test/v1/subscriptions/probe.jobs.watch',
    );
    expect(
      subscriptionUrl({ baseUrl: '/api', routePrefix: '/probe/v1/subscriptions/' }, 'a b', {}),
    ).toBe('/api/probe/v1/subscriptions/a%20b');
  });

  it('sends the input as a query string: arrays repeat a key, undefined is left out', () => {
    expect(
      subscriptionUrl({ baseUrl: '/api' }, 'probe.jobs.watch', {
        topic: 'jobs',
        kinds: ['a', 'b'],
        fromCursor: undefined,
        limit: 5,
        flag: true,
        nested: { x: 1 },
      }),
    ).toBe(
      '/api/v1/subscriptions/probe.jobs.watch?topic=jobs&kinds=a&kinds=b&limit=5&flag=true&nested=%7B%22x%22%3A1%7D',
    );
  });

  it('sends no query for an input that is not an object', () => {
    expect(subscriptionUrl({ baseUrl: '/api' }, 'probe.jobs.watch', undefined)).toBe(
      '/api/v1/subscriptions/probe.jobs.watch',
    );
  });
});
