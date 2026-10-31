/**
 * What counts as a write, and that a write is refused while the server is unreachable at the
 * request, whoever makes it: the Bureau's client, the Weft client's `fetch`, or a bare `fetch`.
 */
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import { callBureau } from './bureau-client.ts';
import { ServerUnreachableError } from './faults.ts';
import { armWriteGuard, classifyRequest, isReadOperation, READ_OPERATIONS } from './write-guard.ts';

const jsonRpc = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: method, method });

describe('classifyRequest', () => {
  test('a GET, HEAD or OPTIONS reads', () => {
    for (const method of ['GET', 'head', 'OPTIONS']) {
      expect(classifyRequest('http://localhost/v1/workflows', method)).toBe('read');
    }
  });

  test('a JSON-RPC call is a read only when every operation in it is one', () => {
    const url = 'http://localhost/bureau/jsonrpc';
    expect(classifyRequest(url, 'POST', jsonRpc('bureau.reviews.get'))).toBe('read');
    expect(classifyRequest(url, 'POST', jsonRpc('weft.workflows.list'))).toBe('read');
    expect(classifyRequest(url, 'POST', jsonRpc('bureau.reviews.resolve'))).toBe('write');
    expect(classifyRequest(url, 'POST', jsonRpc('bureau.tasks.cancel'))).toBe('write');
    expect(
      classifyRequest(
        url,
        'POST',
        `[${jsonRpc('bureau.tasks.get')},${jsonRpc('bureau.tasks.cancel')}]`,
      ),
    ).toBe('write');
  });

  test('an operation nobody classified, and a body nobody can read, count as writes', () => {
    const url = 'http://localhost/v1/jsonrpc';
    expect(classifyRequest(url, 'POST', jsonRpc('bureau.brand.new.operation'))).toBe('write');
    expect(classifyRequest(url, 'POST', 'not json')).toBe('write');
    expect(classifyRequest(url, 'POST')).toBe('write');
    expect(classifyRequest(url, 'POST', JSON.stringify({ method: 7 }))).toBe('write');
    expect(classifyRequest('http://localhost/v1/anything/new', 'POST')).toBe('write');
    expect(classifyRequest('http://localhost/v1/anything/new', 'PUT')).toBe('write');
    expect(classifyRequest('http://localhost/v1/anything/new', 'DELETE')).toBe('write');
  });

  test('a workflow query is a read although it is a POST', () => {
    expect(classifyRequest('http://localhost/v1/workflows/w-1/query/status', 'POST')).toBe('read');
    expect(classifyRequest('http://localhost/v1/workflows/w-1/signal/status', 'POST')).toBe(
      'write',
    );
  });

  test('every read operation is one lowercase segment', () => {
    for (const name of READ_OPERATIONS) expect(name).toBe(name.toLowerCase());
    expect(isReadOperation('bureau.schedules.subscribeEvents')).toBe(true);
    expect(isReadOperation('bureau.schedules.pause')).toBe(false);
  });
});

describe('armWriteGuard', () => {
  let release: (() => void) | undefined;
  afterEach(() => {
    release?.();
    release = undefined;
  });

  function arm(initiallyDown: boolean) {
    const state = { down: initiallyDown, sent: [] as string[] };
    const target = {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input.toString();
          state.sent.push(`${init?.method ?? 'GET'} ${url}`);
          return new Response('{}');
        },
        { preconnect: fetch.preconnect },
      ),
    };
    const original = target.fetch;
    release = armWriteGuard(() => state.down, ['http://localhost'], target);
    return { state, target, original };
  }

  test('refuses a write to the server while it is down, sends reads, and sends everything once it is up', async () => {
    const { state, target } = arm(true);
    const refused = await rejectionOf(
      target.fetch('http://localhost/v1/workflows/w-1/cancel', { method: 'POST' }),
    );
    expect(refused).toBeInstanceOf(ServerUnreachableError);
    await target.fetch('http://localhost/v1/workflows');
    await target.fetch('http://localhost/v1/workflows/w-1/query/status', { method: 'POST' });
    expect(state.sent).toEqual([
      'GET http://localhost/v1/workflows',
      'POST http://localhost/v1/workflows/w-1/query/status',
    ]);

    state.down = false;
    await target.fetch('http://localhost/v1/workflows/w-1/cancel', { method: 'POST' });
    expect(state.sent).toHaveLength(3);
  });

  test('lets a write to another origin through', async () => {
    const { state, target } = arm(true);
    await target.fetch('http://elsewhere.example/hook', { method: 'POST' });
    expect(state.sent).toEqual(['POST http://elsewhere.example/hook']);
  });

  test('makes the Bureau client refuse a write by operation, whatever fetch it was given', async () => {
    const { state } = arm(true);
    let sent = 0;
    const fetcher = async () => {
      sent += 1;
      return Response.json({ jsonrpc: '2.0', id: 'x', result: { ok: true } });
    };
    expect(
      await rejectionOf(callBureau('bureau.tasks.cancel', { taskId: 't' }, { fetch: fetcher })),
    ).toBeInstanceOf(ServerUnreachableError);
    expect(sent).toBe(0);
    await callBureau('bureau.tasks.get', { taskId: 't' }, { fetch: fetcher });
    expect(sent).toBe(1);
    state.down = false;
    await callBureau('bureau.tasks.cancel', { taskId: 't' }, { fetch: fetcher });
    expect(sent).toBe(2);
  });

  test('puts the previous fetch back', () => {
    const { target, original } = arm(false);
    expect(target.fetch).not.toBe(original);
    release?.();
    release = undefined;
    expect(target.fetch).toBe(original);
  });
});
