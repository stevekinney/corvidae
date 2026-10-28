/**
 * Tests for the scripted fetch the System tests stand on: a request body that is not JSON matches
 * no JSON-RPC route and falls through to the queue, and `parseJsonObject` answers only objects.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { parseJsonObject, ScriptedFetch } from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;
afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

describe('parseJsonObject', () => {
  test('answers a JSON object as a plain record', () => {
    expect(parseJsonObject('{"method":"weft.system.metrics","params":{}}')).toEqual({
      method: 'weft.system.metrics',
      params: {},
    });
  });

  test('answers nothing for JSON that is not an object', () => {
    for (const body of ['null', '[1,2]', '"text"', '7', 'true']) {
      expect(parseJsonObject(body)).toBeUndefined();
    }
  });
});

describe('a request body that is not JSON', () => {
  type Route = (fetched: ScriptedFetch) => void;
  const routes: ReadonlyArray<readonly [string, Route]> = [
    ['routeJsonRpcMethod', (fetched) => fetched.routeJsonRpcMethod('weft.system.metrics', {})],
    [
      'routeJsonRpcMethodSequence',
      (fetched) => fetched.routeJsonRpcMethodSequence('weft.system.metrics', [{}]),
    ],
    [
      'routeJsonRpcDeferred',
      (fetched) => fetched.routeJsonRpcDeferred('weft.system.metrics', Promise.resolve({})),
    ],
    [
      'routeJsonRpcError',
      (fetched) =>
        fetched.routeJsonRpcError('weft.system.metrics', { code: -32000, message: 'Refused' }),
    ],
  ];

  test.each(routes)(
    'matches no route registered with %s, so the queue answers it',
    async (_name, route) => {
      scripted = new ScriptedFetch();
      route(scripted);
      scripted.enqueueText('from the queue');

      const response = await fetch('http://weft.test/api/jsonrpc', {
        method: 'POST',
        body: 'this is not json',
      });

      expect(await response.text()).toBe('from the queue');
    },
  );

  test('is told apart from a JSON-RPC request the route does match', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.system.metrics', { answered: true });

    const response = await fetch('http://weft.test/api/jsonrpc', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.system.metrics', params: {} }),
    });

    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { answered: true } });
  });
});
