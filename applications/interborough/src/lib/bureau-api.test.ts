/**
 * The generated Bureau client as the browser holds it: its calls are the JSON-RPC body `callBureau`
 * posts, to the composed `/jsonrpc`; a write the guard refuses never reaches `fetch`; a fault is the
 * `HttpClientError` the console treats; and a call's signal and `fetch` reach the request.
 */
import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';

import { bureauClient } from './bureau-api.ts';
import { callBureau } from './bureau-client.ts';
import { ServerUnreachableError } from './faults.ts';
import { armWriteGuard } from './write-guard.ts';

type Sent = { url: string; init: RequestInit | undefined };

/** A `fetch` that records what it was asked and answers with `answer`. */
function answering(answer: () => Response) {
  const sent: Sent[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: input instanceof Request ? input.url : input.toString(), init });
    return answer();
  };
  return { sent, fetcher };
}

const result = (value: unknown) => () => Response.json({ jsonrpc: '2.0', id: 'x', result: value });

describe('the generated Bureau client', () => {
  test('posts the JSON-RPC body callBureau posts, to the composed /jsonrpc', async () => {
    const generated = answering(result({ id: 'bureau-1' }));
    const hand = answering(result({ id: 'bureau-1' }));

    const answer: unknown = await bureauClient['bureau.deployment.get'](
      {},
      { fetch: generated.fetcher },
    );
    expect(answer).toEqual({ id: 'bureau-1' });
    await callBureau('bureau.deployment.get', {}, { fetch: hand.fetcher });

    expect(generated.sent[0]?.url).toBe('/jsonrpc');
    expect(hand.sent[0]?.url).toBe('/bureau/jsonrpc');
    expect(generated.sent[0]?.init?.method).toBe('POST');
    expect(generated.sent[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(generated.sent[0]?.init?.body).toBe(hand.sent[0]?.init?.body);
    expect(JSON.parse(String(generated.sent[0]?.init?.body))).toEqual({
      jsonrpc: '2.0',
      id: 'bureau.deployment.get',
      method: 'bureau.deployment.get',
      params: {},
    });
  });

  test('throws a fault as an HttpClientError with its status, message and data', async () => {
    const fault = () =>
      Response.json({
        jsonrpc: '2.0',
        id: 'x',
        error: {
          code: -32000,
          message: 'Used',
          data: { weftCode: 'Conflict', httpStatus: 409, reason: 'session-terminal' },
        },
      });
    const generated = answering(fault);
    const hand = answering(fault);

    const error = await rejectionOf(
      bureauClient['bureau.deployment.get']({}, { fetch: generated.fetcher }),
    );
    const expected = await rejectionOf(
      callBureau('bureau.deployment.get', {}, { fetch: hand.fetcher }),
    );

    expect(error).toBeInstanceOf(HttpClientError);
    expect(error).toMatchObject({
      status: 409,
      message: 'Used',
      data: { weftCode: 'Conflict', httpStatus: 409, reason: 'session-terminal' },
    });
    expect(error).toEqual(expected as Error);
  });

  test('a body that is not JSON-RPC is an error with the status of the response', async () => {
    const generated = answering(() => new Response('Forbidden', { status: 403 }));

    expect(
      await rejectionOf(bureauClient['bureau.deployment.get']({}, { fetch: generated.fetcher })),
    ).toMatchObject({ status: 403 });
  });

  test('carries the abort signal and the fetch of one call into the request', async () => {
    const controller = new AbortController();
    const generated = answering(result({ id: 'bureau-1' }));

    await bureauClient['bureau.deployment.get'](
      {},
      { signal: controller.signal, fetch: generated.fetcher },
    );

    expect(generated.sent).toHaveLength(1);
    expect(generated.sent[0]?.init?.signal).toBe(controller.signal);
  });

  test('an aborted signal rejects the call, as it does for callBureau', async () => {
    const controller = new AbortController();
    const abortable = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
      return new Response();
    };
    const pending = rejectionOf(
      bureauClient['bureau.deployment.get']({}, { signal: controller.signal, fetch: abortable }),
    );
    controller.abort(new Error('stopped'));

    expect(await pending).toMatchObject({ message: 'stopped' });
  });

  test('reads the global fetch at the call, so a replacement installed after the client is used', async () => {
    const generated = answering(result({ id: 'bureau-1' }));
    const before = globalThis.fetch;
    globalThis.fetch = Object.assign(generated.fetcher, { preconnect: before.preconnect });
    try {
      await bureauClient['bureau.deployment.get']({});
    } finally {
      globalThis.fetch = before;
    }
    expect(generated.sent[0]?.url).toBe('/jsonrpc');
  });
});

describe('the generated Bureau client and the write guard', () => {
  let release: (() => void) | undefined;
  afterEach(() => {
    release?.();
    release = undefined;
  });

  test('a write the guard refuses never reaches fetch, and a read and a write once the server is back do', async () => {
    const state = { down: true };
    const target = {
      fetch: Object.assign(async () => new Response('{}'), { preconnect: fetch.preconnect }),
    };
    release = armWriteGuard(() => state.down, ['http://localhost'], target);
    const generated = answering(result({ ok: true }));

    expect(
      await rejectionOf(
        bureauClient['bureau.tasks.cancel']({ taskId: 't' }, { fetch: generated.fetcher }),
      ),
    ).toBeInstanceOf(ServerUnreachableError);
    expect(generated.sent).toHaveLength(0);

    await bureauClient['bureau.tasks.get']({ taskId: 't' }, { fetch: generated.fetcher });
    expect(generated.sent).toHaveLength(1);

    state.down = false;
    await bureauClient['bureau.tasks.cancel']({ taskId: 't' }, { fetch: generated.fetcher });
    expect(generated.sent).toHaveLength(2);
  });
});
