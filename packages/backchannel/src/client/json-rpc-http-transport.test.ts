import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { CatalogClientError, createCatalogClient, type CatalogFetch } from './catalog-client.ts';
import { httpJsonRpcTransport, jsonRpcHttpEndpoint } from './json-rpc-http-transport.ts';

type Recorded = {
  readonly url: string;
  readonly init: RequestInit | undefined;
  /** The JSON body the request carried, parsed. */
  readonly body: Record<string, unknown>;
};

/** A `fetch` that records each request and answers with the given envelope. */
function recordingFetch(
  answer: unknown,
  requests: Recorded[] = [],
): { readonly fetch: CatalogFetch; readonly requests: Recorded[] } {
  const stub: CatalogFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '{}';
    requests.push({ url, init, body: JSON.parse(body) as Record<string, unknown> });
    const parsed = JSON.parse(body) as { id: string };
    return Response.json(
      typeof answer === 'object' && answer !== null && 'id' in answer
        ? { ...answer, id: parsed.id }
        : answer,
    );
  };
  return { fetch: stub, requests };
}

const echoed = { jsonrpc: '2.0', id: 'catalog-client', result: { message: 'hello' } };

describe('jsonRpcHttpEndpoint', () => {
  it('appends /jsonrpc to an absolute base, with or without a trailing slash', () => {
    expect(jsonRpcHttpEndpoint('https://api.example.test')).toBe(
      'https://api.example.test/jsonrpc',
    );
    expect(jsonRpcHttpEndpoint('https://api.example.test/base/')).toBe(
      'https://api.example.test/base/jsonrpc',
    );
  });

  it('appends /jsonrpc to a path the browser resolves, without building a URL', () => {
    expect(jsonRpcHttpEndpoint('/api')).toBe('/api/jsonrpc');
    expect(jsonRpcHttpEndpoint('')).toBe('/jsonrpc');
  });

  it('drops a query and a fragment from the base', () => {
    expect(jsonRpcHttpEndpoint('https://api.example.test/base?x=1#top')).toBe(
      'https://api.example.test/base/jsonrpc',
    );
  });
});

describe('httpJsonRpcTransport', () => {
  it('correlates reverse-order concurrent responses with distinct default request ids', async () => {
    const requests: { id: string; resolve: (response: Response) => void }[] = [];
    const fetch: CatalogFetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return new Promise((resolve) => requests.push({ id: request.id, resolve }));
    };
    const transport = httpJsonRpcTransport({ baseUrl: '/api', fetch });
    const first = transport('probe.first', {});
    const second = transport('probe.second', {});
    expect(requests[0]!.id).not.toBe(requests[1]!.id);
    requests[1]!.resolve(Response.json({ jsonrpc: '2.0', id: requests[1]!.id, result: 'second' }));
    requests[0]!.resolve(Response.json({ jsonrpc: '2.0', id: requests[0]!.id, result: 'first' }));
    expect(await first).toBe('first');
    expect(await second).toBe('second');
  });

  it('rejects responses with a mismatched id or invalid protocol, including errors', async () => {
    for (const answer of [
      { jsonrpc: '2.0', id: 'different', result: 'wrong' },
      { jsonrpc: '1.0', id: 'expected', result: 'wrong' },
      { jsonrpc: '2.0', id: 'different', error: { code: -32601, message: 'wrong' } },
      { error: { code: -32601, message: 'wrong' } },
    ]) {
      const fetch: CatalogFetch = async () => Response.json(answer);
      await expect(
        httpJsonRpcTransport({ baseUrl: '/api', fetch, requestId: 'expected' })('probe.read', {}),
      ).rejects.toThrow('Invalid JSON-RPC response');
    }
  });
  it('posts a JSON-RPC request to the endpoint with the connection headers', async () => {
    const { fetch: stub, requests } = recordingFetch(echoed);
    const transport = httpJsonRpcTransport({
      baseUrl: '/api',
      headers: { authorization: 'Bearer token' },
      fetch: stub,
    });

    const result = await transport('probe.echo', { message: 'hello' });

    expect(result).toEqual({ message: 'hello' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/api/jsonrpc');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer token',
    });
    expect(requests[0]?.body).toEqual({
      jsonrpc: '2.0',
      method: 'probe.echo',
      params: { message: 'hello' },
      id: expect.stringMatching(/^catalog-client-\d+$/u),
    });
  });

  it('sends the request id its connection names', async () => {
    const { fetch: stub, requests } = recordingFetch(echoed);
    await httpJsonRpcTransport({ baseUrl: '/api', fetch: stub, requestId: 'probe-client' })(
      'probe.echo',
      {},
    );
    expect(requests[0]?.body['id']).toBe('probe-client');
  });

  it('passes a call its own signal and fetch, which override the connection fetch', async () => {
    const connection = recordingFetch(echoed);
    const call = recordingFetch(echoed);
    const controller = new AbortController();
    const transport = httpJsonRpcTransport({ baseUrl: '/api', fetch: connection.fetch });

    await transport('probe.echo', {}, { signal: controller.signal, fetch: call.fetch });

    expect(connection.requests).toHaveLength(0);
    expect(call.requests).toHaveLength(1);
    expect(call.requests[0]?.init?.signal).toBe(controller.signal);
  });

  it('uses the global fetch when neither the call nor the connection brings one', async () => {
    const original = globalThis.fetch;
    const { fetch: stub, requests } = recordingFetch(echoed);
    globalThis.fetch = Object.assign(stub, { preconnect: original.preconnect });
    try {
      await httpJsonRpcTransport({ baseUrl: 'https://api.example.test' })('probe.echo', {});
    } finally {
      globalThis.fetch = original;
    }
    expect(requests[0]?.url).toBe('https://api.example.test/jsonrpc');
  });

  it('rejects with the signal reason when the call is aborted', async () => {
    const controller = new AbortController();
    const abortable: CatalogFetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const pending = httpJsonRpcTransport({ baseUrl: '/api', fetch: abortable })(
      'probe.echo',
      {},
      { signal: controller.signal },
    );
    controller.abort(new Error('stopped'));
    expect(await rejectionOf(pending)).toMatchObject({ message: 'stopped' });
  });

  it('throws a CatalogClientError carrying the code, data and operation of a JSON-RPC error', async () => {
    const { fetch: stub } = recordingFetch({
      jsonrpc: '2.0',
      id: 'catalog-client',
      error: { code: -32601, message: 'Method not found', data: { operation: 'probe.echo' } },
    });
    const error = await httpJsonRpcTransport({ baseUrl: '/api', fetch: stub })(
      'probe.echo',
      {},
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CatalogClientError);
    const failure = error as CatalogClientError;
    expect(failure.code).toBe(-32601);
    expect(failure.isUnknownOperation).toBe(true);
    expect(failure.operationName).toBe('probe.echo');
    expect(failure.data).toEqual({ operation: 'probe.echo' });
  });

  it('treats an envelope with no result as a void success', async () => {
    const { fetch: stub } = recordingFetch({ jsonrpc: '2.0', id: 'catalog-client' });
    expect(await httpJsonRpcTransport({ baseUrl: '/api', fetch: stub })('probe.void', {})).toBe(
      undefined,
    );
  });

  it('throws on a response that is not a JSON-RPC envelope', async () => {
    const { fetch: stub } = recordingFetch({ unexpected: true });
    expect(
      await rejectionOf(httpJsonRpcTransport({ baseUrl: '/api', fetch: stub })('probe.echo', {})),
    ).toMatchObject({ message: 'Invalid JSON-RPC response from /api/jsonrpc' });
  });
});

describe('createCatalogClient', () => {
  type Operations = {
    'probe.echo': {
      readonly input: { message: string };
      readonly output: { message: string };
    };
  };

  it('forwards an operation name, its input and its call options to the transport', async () => {
    const calls: unknown[][] = [];
    const client = createCatalogClient<Operations>(['probe.echo'], async (...args) => {
      calls.push(args);
      return { message: 'hello' };
    });
    const controller = new AbortController();
    const stub = recordingFetch(echoed).fetch;

    const result = await client['probe.echo'](
      { message: 'hello' },
      { signal: controller.signal, fetch: stub },
    );

    expect(result).toEqual({ message: 'hello' });
    expect(calls).toEqual([
      ['probe.echo', { message: 'hello' }, { signal: controller.signal, fetch: stub }],
    ]);
  });

  it('reaches the request through the HTTP transport: the signal and the fetch of one call', async () => {
    const { fetch: stub, requests } = recordingFetch(echoed);
    const controller = new AbortController();
    const client = createCatalogClient<Operations>(
      ['probe.echo'],
      httpJsonRpcTransport({ baseUrl: '/api' }),
    );

    await client['probe.echo']({ message: 'hello' }, { signal: controller.signal, fetch: stub });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.signal).toBe(controller.signal);
  });

  it('builds a method for each name and no more', () => {
    const client = createCatalogClient<Operations>(['probe.echo'], async () => null);
    expect(Object.keys(client)).toEqual(['probe.echo']);
  });
});
