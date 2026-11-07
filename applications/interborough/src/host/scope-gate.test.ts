/**
 * The scopes of Interborough's API on the operations its pages call (`scope-gate.ts`): a Bureau
 * method, an MCP tool call, an AG-UI run and a settings write each need their scope, a request that
 * holds it goes on unread, and every one of the ten scopes gates something, so none is a name that
 * checks nothing.
 */
import { describe, expect, test } from 'bun:test';

import { API_SCOPES, type ApiScope } from '../lib/api-scopes.ts';
import { API_OPERATIONS } from './api-description.ts';
import { localApiPrincipal, type ApiPrincipal } from './api-routes.ts';
import {
  BUREAU_METHOD_SCOPES,
  bureauScopeRefusal,
  refuseWritesWithoutScope,
} from './scope-gate.ts';

/** A principal holding every scope but `without`. */
function lacking(...without: ApiScope[]): ApiPrincipal {
  return {
    subject: 'anonymous:local',
    scopes: new Set(API_SCOPES.filter((scope) => !without.includes(scope))),
  };
}

function jsonRpc(body: unknown, path = '/jsonrpc'): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const call = (method: string, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: {},
});

describe('bureauScopeRefusal', () => {
  test.each([...BUREAU_METHOD_SCOPES])(
    'refuses %s to a session without %s, naming the scope',
    async (method, scope) => {
      const refusal = await bureauScopeRefusal(jsonRpc(call(method, 7)), lacking(scope));
      expect(refusal?.status).toBe(200);
      expect(await refusal?.json()).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32011,
          message: `This session does not hold ${scope}.`,
          data: {
            reason: `This session does not hold ${scope}.`,
            scope,
            weftCode: 'Forbidden',
            httpStatus: 403,
          },
        },
      });
    },
  );

  // Every schedule-writing operation the Bureau serves (`schedules-operations.ts`); list, get and
  // missed are its reads.
  test.each([
    'bureau.schedules.create',
    'bureau.schedules.update',
    'bureau.schedules.pause',
    'bureau.schedules.resume',
    'bureau.schedules.cancel',
    'bureau.schedules.skipnext',
    'bureau.schedules.unskip',
    'bureau.schedules.runnow',
  ])('refuses the schedule write %s to a session without schedules:write', async (method) => {
    const refusal = await bureauScopeRefusal(jsonRpc(call(method)), lacking('schedules:write'));
    expect(await refusal?.json()).toMatchObject({ error: { data: { scope: 'schedules:write' } } });
  });

  test('sends a method on, unread, to a session holding its scope', async () => {
    const request = jsonRpc(call('bureau.schedules.create'));
    expect(await bureauScopeRefusal(request, lacking('hooks:write'))).toBeUndefined();
    expect(request.bodyUsed).toBe(false);
    expect(await request.json()).toEqual(call('bureau.schedules.create'));
  });

  test('sends on a method no scope gates', async () => {
    const request = jsonRpc(call('bureau.goals.list'));
    expect(await bureauScopeRefusal(request, lacking(...API_SCOPES))).toBeUndefined();
  });

  test('lets a session holding every scope through without reading the body', async () => {
    const request = new Request('http://127.0.0.1/jsonrpc', { method: 'POST', body: 'not json' });
    expect(await bureauScopeRefusal(request, localApiPrincipal('anonymous:local'))).toBeUndefined();
  });

  test('sends a body that is not JSON on for the Bureau to answer', async () => {
    const request = new Request('http://127.0.0.1/jsonrpc', { method: 'POST', body: '{' });
    expect(await bureauScopeRefusal(request, lacking('settings:write'))).toBeUndefined();
  });

  test('refuses a whole batch when any entry needs a scope the session lacks', async () => {
    const refusal = await bureauScopeRefusal(
      jsonRpc([
        call('bureau.schedules.list', 1),
        call('bureau.hooks.create', 2),
        { jsonrpc: '2.0', method: 'bureau.settings.update', params: {} },
      ]),
      lacking('hooks:write', 'settings:write'),
    );
    const answers = (await refusal?.json()) as {
      id: number;
      error: { data: { scope: string } };
    }[];
    expect(answers.map((answer) => [answer.id, answer.error.data.scope])).toEqual([
      [1, 'hooks:write'],
      [2, 'hooks:write'],
    ]);
  });

  test('sends on a batch every entry of which the session may send', async () => {
    const request = jsonRpc([call('bureau.schedules.list', 1), call('bureau.hooks.create', 2)]);
    expect(await bureauScopeRefusal(request, lacking('settings:write'))).toBeUndefined();
  });

  test('answers a refused notification with no body', async () => {
    const refusal = await bureauScopeRefusal(
      jsonRpc({ jsonrpc: '2.0', method: 'bureau.settings.update', params: {} }),
      lacking('settings:write'),
    );
    expect(refusal?.status).toBe(204);
  });

  test('refuses an MCP tool call by the tool’s operation, and lets other MCP messages through', async () => {
    const tool = (name: string) => ({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: {} },
    });
    const refusal = await bureauScopeRefusal(
      jsonRpc(tool('bureau.reviews.resolve'), '/mcp'),
      lacking('reviews:write'),
    );
    expect(await refusal?.json()).toMatchObject({ id: 3, error: { code: -32011 } });
    expect(
      await bureauScopeRefusal(jsonRpc(tool('bureau.goals.list'), '/mcp'), lacking(...API_SCOPES)),
    ).toBeUndefined();
    expect(
      await bureauScopeRefusal(
        jsonRpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, '/mcp'),
        lacking(...API_SCOPES),
      ),
    ).toBeUndefined();
  });

  test('refuses sending a message over AG-UI without chats:write, and cancelling without runs:write', async () => {
    const post = (path: string) => new Request(`http://127.0.0.1${path}`, { method: 'POST' });
    const send = await bureauScopeRefusal(
      post('/ag-ui/agents/assistant/run'),
      lacking('chats:write'),
    );
    expect(send?.status).toBe(403);
    expect(await send?.json()).toEqual({
      error: 'forbidden',
      message: 'This session does not hold chats:write.',
      scope: 'chats:write',
    });
    const cancel = await bureauScopeRefusal(
      post('/ag-ui/runs/run-1/cancel'),
      lacking('runs:write'),
    );
    expect(cancel?.status).toBe(403);
    expect(
      await bureauScopeRefusal(post('/ag-ui/agents/assistant/run'), lacking('runs:write')),
    ).toBeUndefined();
  });

  test('never reads a request that is not a POST', async () => {
    const request = new Request('http://127.0.0.1/jsonrpc', { method: 'GET' });
    expect(await bureauScopeRefusal(request, lacking(...API_SCOPES))).toBeUndefined();
  });
});

describe('refuseWritesWithoutScope', () => {
  const allow = () => undefined;
  const request = (method: string) => new Request('http://127.0.0.1/host/plugins/demo', { method });

  test.each(['PUT', 'POST', 'DELETE'])(
    'refuses a %s without the scope, naming it',
    async (method) => {
      const refuse = refuseWritesWithoutScope(allow, 'settings:write', () =>
        lacking('settings:write'),
      );
      const refusal = refuse(request(method));
      expect(refusal?.status).toBe(403);
      expect(await refusal?.json()).toEqual({
        error: 'forbidden',
        message: 'This session does not hold settings:write.',
        scope: 'settings:write',
      });
    },
  );

  test('lets a read through without the scope', () => {
    const refuse = refuseWritesWithoutScope(allow, 'settings:write', () =>
      lacking('settings:write'),
    );
    expect(refuse(request('GET'))).toBeUndefined();
    expect(refuse(request('HEAD'))).toBeUndefined();
  });

  test('lets a write through for a session holding the scope', () => {
    const refuse = refuseWritesWithoutScope(allow, 'settings:write', () => lacking('hooks:write'));
    expect(refuse(request('PUT'))).toBeUndefined();
  });

  test('answers the request guard’s refusal before the scope', () => {
    const guard = new Response('refused', { status: 421 });
    const refuse = refuseWritesWithoutScope(
      () => guard,
      'settings:write',
      () => lacking('settings:write'),
    );
    expect(refuse(request('PUT'))).toBe(guard);
    expect(refuse(request('GET'))).toBe(guard);
  });
});

describe('the ten scopes', () => {
  test('each gates an /api operation or an operation the pages call', () => {
    const gated = new Set<ApiScope>([
      ...API_OPERATIONS.map((operation) => operation.scope),
      ...BUREAU_METHOD_SCOPES.values(),
    ]);
    expect(API_SCOPES.filter((scope) => !gated.has(scope))).toEqual([]);
  });
});
