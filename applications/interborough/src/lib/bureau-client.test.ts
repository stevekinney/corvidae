/**
 * `callBureau`: one JSON-RPC call to the Bureau's management plane, with a fault answered as the
 * `HttpClientError` the console's fault treatments already read.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { BUREAU_PATH, callBureau, type Fetcher } from './bureau-client.ts';
import { bodyText, urlOf } from './bureau-stub.test-support.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';

function answering(body: unknown, init: ResponseInit = {}): Fetcher {
  return async () => Response.json(body, init);
}

/** The error `callBureau` throws, or a failure if it throws none. */
async function thrownBy(call: Promise<unknown>): Promise<HttpClientError> {
  const outcome = await call.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof HttpClientError)) throw new Error('Expected an HttpClientError.');
  return outcome;
}

describe('callBureau', () => {
  test('posts the method and its params to the Bureau’s JSON-RPC route and returns the result', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const result = await callBureau(
      'bureau.agents.catalog',
      { limit: 1 },
      {
        fetch: async (input, init) => {
          requests.push({ url: urlOf(input), init });
          return Response.json({ jsonrpc: '2.0', id: 'bureau.agents.catalog', result: { ok: 1 } });
        },
      },
    );

    expect(result).toEqual({ ok: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${BUREAU_PATH}/jsonrpc`);
    expect(requests[0]?.init?.method).toBe('POST');
    expect(JSON.parse(bodyText(requests[0]?.init))).toEqual({
      jsonrpc: '2.0',
      id: 'bureau.agents.catalog',
      method: 'bureau.agents.catalog',
      params: { limit: 1 },
    });
  });

  test('passes an abort signal through to the request', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    await callBureau(
      'bureau.agents.catalog',
      {},
      {
        signal: controller.signal,
        fetch: async (_input, init) => {
          seen = init?.signal;
          return Response.json({ result: null });
        },
      },
    );
    expect(seen).toBe(controller.signal);
  });

  test('uses the global fetch when none is given', async () => {
    const restore = installFetchImplementation(async () => Response.json({ result: 7 }));
    try {
      expect(await callBureau('bureau.agents.catalog', {})).toBe(7);
    } finally {
      restore();
    }
  });

  test('throws the fault the Bureau answered, with its status, message, and payload', async () => {
    const error = await thrownBy(
      callBureau(
        'bureau.agents.definitions.update',
        {},
        {
          fetch: answering({
            jsonrpc: '2.0',
            id: 'x',
            error: {
              code: -32010,
              message: 'The agent file changed.',
              data: { weftCode: 'StaleRevision', httpStatus: 409, currentRevision: 'abc' },
            },
          }),
        },
      ),
    );
    expect(error.status).toBe(409);
    expect(error.message).toBe('The agent file changed.');
    expect(error.data?.['weftCode']).toBe('StaleRevision');
    expect(error.data?.['currentRevision']).toBe('abc');
  });

  test('falls back to the HTTP status and a status message when the fault says neither', async () => {
    const error = await thrownBy(
      callBureau('x', {}, { fetch: answering({ error: { code: 1 } }, { status: 502 }) }),
    );
    expect(error.status).toBe(502);
    expect(error.message).toBe('HTTP 502');
    expect(error.data).toBeUndefined();
  });

  test('throws the HTTP status when the body is not JSON', async () => {
    const error = await thrownBy(
      callBureau(
        'x',
        {},
        {
          fetch: async () =>
            new Response('Bad gateway', { status: 502, statusText: 'Bad Gateway' }),
        },
      ),
    );
    expect(error.status).toBe(502);
    expect(error.message).toBe('Bad Gateway');
  });

  test('throws the HTTP status when the body is not JSON and the response has no status text', async () => {
    const error = await thrownBy(
      callBureau('x', {}, { fetch: async () => new Response('nope', { status: 500 }) }),
    );
    expect(error.message).toBe('HTTP 500');
  });

  test('throws when the answer holds neither a result nor a fault', async () => {
    const error = await thrownBy(
      callBureau('x', {}, { fetch: answering({ error: 'The server broke.' }, { status: 500 }) }),
    );
    expect(error.status).toBe(500);
    expect(error.message).toBe('The Bureau answered with no result.');
    const empty = await thrownBy(callBureau('x', {}, { fetch: answering([]) }));
    expect(empty.message).toBe('The Bureau answered with no result.');
  });
});
