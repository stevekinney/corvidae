/**
 * What the followers read of the generated subscription methods: the moment the Bureau accepts a
 * stream and the first bytes of it, a refusal as the fault its status makes, and a stream that
 * reports an error or ends, which the follower resumes as it does any end.
 */
import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { bureauClient } from './bureau-api.ts';
import { acceptedFetch, eventsOf } from './bureau-subscriptions.ts';
import { classifyFault } from './faults.ts';

const STREAM = { 'content-type': 'text/event-stream' };

const frame = (id: string, event: string, data: unknown): string =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const PING = `event: ping\ndata: ${JSON.stringify({ emittedAtMs: 0, replayComplete: true })}\n\n`;

/** The task feed opened over `answer`, as a follower opens it. */
function open(
  answer: () => Response,
  hooks: { onOpen?: () => void; onData?: () => void; lastEventId?: string } = {},
) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: new Headers(init?.headers) });
    return answer();
  };
  const messages = bureauClient['bureau.tasks.events'](
    { taskId: 'run-1' },
    {
      fetch: acceptedFetch({ fetch: fetcher, ...hooks }),
      ...(hooks.lastEventId === undefined ? {} : { lastEventId: hooks.lastEventId }),
    },
  );
  return { seen, events: eventsOf(messages, 'task stream') };
}

async function collect<Item>(items: AsyncIterable<Item>): Promise<Item[]> {
  const collected: Item[] = [];
  for await (const item of items) collected.push(item);
  return collected;
}

describe('the generated subscription of a Bureau feed', () => {
  test('opens the route of the feed, resumes after the id it is given, and yields each event once', async () => {
    const { seen, events } = open(
      () =>
        new Response(PING + frame('7', 'task.status', { kind: 'task.status', cursor: '7' }), {
          headers: STREAM,
        }),
      { lastEventId: '6' },
    );

    const received: unknown[] = await collect(events);
    expect(received).toEqual([{ id: '7', data: { kind: 'task.status', cursor: '7' } }]);
    expect(seen[0]?.url).toBe('/bureau/v1/subscriptions/bureau.tasks.events?taskId=run-1');
    expect(seen[0]?.headers.get('last-event-id')).toBe('6');
    expect(seen[0]?.headers.get('accept')).toBe('text/event-stream');
  });

  test('says when the Bureau has accepted the stream, and when the first bytes of it arrive', async () => {
    const order: string[] = [];
    const { events } = open(() => new Response(PING, { headers: STREAM }), {
      onOpen: () => order.push('open'),
      onData: () => order.push('data'),
    });

    await collect(events);

    expect(order).toEqual(['open', 'data']);
  });

  test('says neither for a refusal or for an answer that is not an event stream', async () => {
    const order: string[] = [];
    const hooks = { onOpen: () => order.push('open'), onData: () => order.push('data') };

    await rejectionOf(collect(open(() => new Response('no', { status: 503 }), hooks).events));
    await rejectionOf(collect(open(() => new Response('hi'), hooks).events));

    expect(order).toEqual([]);
  });

  test('a refusal is the fault its status says it is, with the words of its body or the stream’s own', async () => {
    const withWords = await rejectionOf(
      collect(
        open(() => Response.json({ error: 'No task with id "run-9"' }, { status: 404 })).events,
      ),
    );
    const withoutWords = await rejectionOf(
      collect(open(() => new Response('Bad gateway', { status: 502 })).events),
    );

    expect(withWords).toBeInstanceOf(HttpClientError);
    expect(withWords).toMatchObject({ status: 404, message: 'No task with id "run-9"' });
    expect(classifyFault(withWords)?.kind).toBe('not-found');
    expect(withoutWords).toMatchObject({ status: 502, message: 'The task stream answered 502.' });
  });

  test('a stream that reports an error ends the events, without a fault, so the follower resumes it', async () => {
    const { events } = open(
      () =>
        new Response(
          frame('1', 'task.status', { kind: 'task.status', cursor: '1' }) +
            'event: error\ndata: {"message":"boom"}\n\n',
          { headers: STREAM },
        ),
    );

    const received: unknown[] = await collect(events);
    expect(received).toEqual([{ id: '1', data: { kind: 'task.status', cursor: '1' } }]);
  });

  test('aborting the signal ends the events without a fault', async () => {
    const controller = new AbortController();
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason));
          },
        }),
        { headers: STREAM },
      );
    const events = eventsOf(
      bureauClient['bureau.tasks.events'](
        { taskId: 'run-1' },
        { fetch: acceptedFetch({ fetch: fetcher }), signal: controller.signal },
      ),
      'task stream',
    );
    const pending = collect(events);
    controller.abort();

    expect(await pending).toEqual([]);
  });
});
