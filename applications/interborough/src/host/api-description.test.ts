/**
 * The OpenAPI description of Interborough's API (`api-description.ts`): the seven operations the
 * board lists, in its order, each naming the scope the route enforces, with the request and
 * response the board opens for `POST /api/runs`. The scope each operation names is checked against
 * the route itself, so the description cannot drift from what the routes do.
 */
import { describe, expect, test } from 'bun:test';

import { API_SCOPES, type ApiScope } from '../lib/api-scopes.ts';
import { API_OPERATIONS, API_SCOPE_EXTENSION, apiDescription } from './api-description.ts';
import { apiRoutes, type ApiBureau } from './api-routes.ts';

type Operation = Record<string, unknown> & {
  readonly summary: string;
  readonly tags: readonly string[];
  readonly requestBody?: { content: { 'application/json': { schema: { example: unknown } } } };
  readonly responses: Record<
    string,
    { content?: { 'application/json': { schema: { example: unknown } } } }
  >;
};

const document = apiDescription('http://127.0.0.1:4310') as {
  readonly openapi: string;
  readonly servers: readonly { url: string }[];
  readonly paths: Record<string, Record<string, Operation>>;
};

const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    method: method.toUpperCase(),
    path,
    operation,
  })),
);

describe('the API description', () => {
  test('is OpenAPI 3.1 naming the host as its server', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.servers).toEqual([{ url: 'http://127.0.0.1:4310' }]);
  });

  test('lists the board’s seven operations, in its order, each with what it does and its scope', () => {
    expect(
      operations.map(({ method, path, operation }) => [
        method,
        path,
        operation.summary,
        operation[API_SCOPE_EXTENSION],
      ]),
    ).toEqual([
      ['GET', '/api/runs', 'List runs', 'runs:read'],
      ['POST', '/api/runs', 'Start a run', 'runs:write'],
      ['GET', '/api/runs/{run}', 'Get one run and its steps', 'runs:read'],
      ['POST', '/api/chats/{chat}/messages', 'Send a message to a chat', 'chats:write'],
      ['GET', '/api/agents', 'List agents', 'agents:read'],
      ['GET', '/api/schedules', 'List schedules', 'schedules:read'],
      ['POST', '/api/reviews/{review}/decision', 'Approve or deny a review', 'reviews:write'],
    ]);
  });

  test('POST /api/runs takes the board’s request body and answers 201 with its response', () => {
    const start = document.paths['/api/runs']?.['post'];
    expect(start?.requestBody?.content['application/json'].schema.example).toEqual({
      workflow: 'order-refund',
      input: { order: 4471 },
    });
    expect(start?.responses['201']?.content?.['application/json'].schema.example).toEqual({
      run: 'run-1-9f3a',
      status: 'running',
    });
  });

  test('POST /api/chats/{chat}/messages documents the 409 for a chat with a turn in progress, and no other operation does', () => {
    const send = document.paths['/api/chats/{chat}/messages']?.['post'];
    expect(send?.responses['409']).toBeDefined();
    expect(String(send?.['description'])).toContain('409');
    const withConflict = operations
      .filter(({ operation }) => operation.responses['409'] !== undefined)
      .map(({ method, path }) => `${method} ${path}`);
    expect(withConflict).toEqual(['POST /api/chats/{chat}/messages']);
  });

  test('every example is one the route takes or answers with', () => {
    for (const operation of API_OPERATIONS) {
      expect(operation.response.schema.safeParse(operation.response.example).success).toBe(true);
      if (operation.body !== undefined) {
        expect(operation.body.schema.safeParse(operation.body.example).success).toBe(true);
      }
    }
  });
});

describe('each operation’s scope', () => {
  const bureau = new Proxy({} as ApiBureau, {
    get: () => {
      throw new Error('The scope is checked before the Bureau is called.');
    },
  });

  for (const { method, path, operation } of operations) {
    const scope = operation[API_SCOPE_EXTENSION] as ApiScope;
    test(`is the one ${method} ${path} enforces`, async () => {
      const routePath = path.replaceAll(/\{(\w+)\}/g, ':$1');
      const concrete = path.replaceAll(/\{(\w+)\}/g, 'x');
      const lacking = API_SCOPES.filter((candidate) => candidate !== scope);
      const routes = apiRoutes(
        {
          bureau,
          timeline: async () => [],
          startTurn: async () => {
            throw new Error('The scope is checked before the Bureau is called.');
          },
          principal: () => ({ subject: 'anonymous:local', scopes: new Set(lacking) }),
        },
        () => undefined,
      );
      const handler = routes[routePath]?.[method as 'GET' | 'POST'];
      expect(handler).toBeDefined();
      const request = Object.assign(new Request(`http://127.0.0.1${concrete}`, { method }), {
        params: {},
      }) as unknown as Bun.BunRequest<string>;
      const response = await handler!(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ scope });
    });
  }
});
