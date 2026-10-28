/** Tests for the Bureau stub the page tests stand on: what it answers to a request that is not a call. */
import { afterEach, describe, expect, test } from 'bun:test';

import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function post(body: string): Promise<Response> {
  return fetch('/bureau/jsonrpc', { method: 'POST', body });
}

describe('the Bureau stub', () => {
  test('answers 400 to a body that is JSON but names no method, and records no call', async () => {
    stub = installBureauStub({ 'bureau.agents.list': () => ({}) });

    for (const body of ['[]', '"text"', 'null', '{}', '{"method":7}']) {
      const response = await post(body);
      expect(response.status, body).toBe(400);
      expect(await response.text()).toBe('Bad request');
    }
    expect(stub.calls).toEqual([]);
  });

  test('answers a call to a method it has a handler for, and records it', async () => {
    stub = installBureauStub({ 'bureau.agents.list': (params) => ({ echoed: params }) });

    const response = await post(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'bureau.agents.list', params: { a: 1 } }),
    );

    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 3, result: { echoed: { a: 1 } } });
    expect(stub.callsTo('bureau.agents.list')).toEqual([
      { method: 'bureau.agents.list', params: { a: 1 } },
    ]);
  });
});
