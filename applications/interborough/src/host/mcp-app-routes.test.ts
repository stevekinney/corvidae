/**
 * COR-1894: the host routes behind a plugin's MCP-app panel. The page's HTML is served to the
 * panel's resource loader, and the panel's tool calls reach the Bureau in process only when the
 * app declared the tool. Every refusal is tested with a double for the Bureau's handler, so the
 * assertion that nothing ran is "the double was never called".
 */
import { describe, expect, mock, test } from 'bun:test';

import type { ServedMcpApp } from './mcp-app-mounts.ts';
import { mcpAppRoutes } from './mcp-app-routes.ts';
import { createRequestGuard } from './request-guard.ts';

const PORT = 4321;
const HOST = `127.0.0.1:${PORT}`;
const PAGE = '<div id="root"></div><script>window.ran = true</script>';

const app = (overrides: Partial<ServedMcpApp> = {}): ServedMcpApp => ({
  plugin: 'inspectors',
  name: 'run-inspector',
  title: 'Run inspector',
  uri: 'ui://bureau/run-inspector/v1',
  opensFromTool: 'bureau.tasks.inspect',
  allowedTools: ['bureau.tasks.inspect', 'bureau.tasks.cancel'],
  html: PAGE,
  ...overrides,
});

const RESULT = {
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: { task: { id: 't' } },
};

/** A Bureau handler that answers one JSON-RPC result, and records the requests it was given. */
function bureauDouble(body: unknown = { jsonrpc: '2.0', id: 1, result: RESULT }) {
  return mock(async (_request: Request) => Response.json(body));
}

function routes(
  callBureau: (request: Request) => Promise<Response>,
  served: readonly ServedMcpApp[] = [app()],
) {
  return mcpAppRoutes(
    served,
    createRequestGuard(() => PORT),
    callBureau,
  );
}

const PAGE_ROUTE = '/host/plugins/inspectors/apps/run-inspector';
const CALL_ROUTE = `${PAGE_ROUTE}/tool-calls`;
const LIST_ROUTE = '/host/mcp-apps';

/** The handler the route table holds for a method, called as the server would. */
async function call(
  table: ReturnType<typeof routes>,
  route: 'page' | 'call' | 'list',
  init: { path?: string; headers?: Record<string, string>; body?: unknown; method?: string } = {},
): Promise<Response> {
  const path = init.path ?? { page: PAGE_ROUTE, call: CALL_ROUTE, list: LIST_ROUTE }[route];
  const method = init.method ?? (route === 'call' ? 'POST' : 'GET');
  const request = Object.assign(
    new Request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, 'content-type': 'application/json', ...init.headers },
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
    }),
    {
      params: {
        name: decodeURIComponent(path.split('/')[3] ?? ''),
        app: decodeURIComponent(path.split('/')[5] ?? ''),
      },
    },
  );
  const entry = Object.entries(table).find(([pattern]) =>
    route === 'list'
      ? pattern === LIST_ROUTE
      : route === 'call'
        ? pattern.endsWith('/tool-calls')
        : pattern.endsWith(':app'),
  );
  if (entry === undefined) throw new Error('No such route.');
  const handlers = entry[1] as Record<string, (request: never) => Response | Promise<Response>>;
  const handler = handlers[method];
  if (handler === undefined) throw new Error(`No ${method} handler.`);
  return handler(request as never);
}

describe('GET a panel’s page', () => {
  test('answers the app’s HTML and its deny-by-default security metadata as JSON', async () => {
    const response = await call(routes(bureauDouble()), 'page');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = (await response.json()) as { html: string; ui: { csp: unknown } };
    expect(body.html).toBe(PAGE);
    expect(body.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
  });

  test('answers 404 for a plugin or an app that is not served, and says nothing of the page', async () => {
    const table = routes(bureauDouble());
    for (const path of [
      '/host/plugins/nobody/apps/run-inspector',
      '/host/plugins/inspectors/apps/nothing',
      '/host/plugins/__proto__/apps/constructor',
    ]) {
      const response = await call(table, 'page', { path });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('root');
    }
  });

  test.each([
    ['another origin', { origin: 'http://attacker.example' }],
    ['a rebound host name', { host: 'attacker.example' }],
  ])('gives %s no HTML', async (_name, headers) => {
    const response = await call(routes(bureauDouble()), 'page', { headers });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('root');
  });
});

describe('GET the panels the host serves', () => {
  test('lists each app without its page or its allowed tools', async () => {
    const response = await call(routes(bureauDouble()), 'list');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      apps: [
        {
          plugin: 'inspectors',
          app: 'run-inspector',
          title: 'Run inspector',
          uri: 'ui://bureau/run-inspector/v1',
          opensFromTool: 'bureau.tasks.inspect',
        },
      ],
    });
  });

  test('is refused from another origin', async () => {
    const response = await call(routes(bureauDouble()), 'list', {
      headers: { origin: 'http://attacker.example' },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('inspectors');
  });
});

describe('POST a panel’s tool call', () => {
  test('passes a declared Bureau tool to the Bureau in process, as a tools/call, and returns its result untouched', async () => {
    const bureau = bureauDouble();
    const response = await call(routes(bureau), 'call', {
      body: { name: 'bureau.tasks.inspect', arguments: { taskId: 'task-1' } },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
    expect(bureau).toHaveBeenCalledTimes(1);
    const sent = bureau.mock.calls[0]?.[0] as Request;
    expect(sent.method).toBe('POST');
    expect(new URL(sent.url).pathname).toBe('/mcp');
    expect(await sent.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'bureau.tasks.inspect', arguments: { taskId: 'task-1' } },
    });
  });

  test('forwards no header of the browser’s request, so the Bureau answers as the local owner', async () => {
    const bureau = bureauDouble();
    await call(routes(bureau), 'call', {
      headers: { authorization: 'Bearer stolen', 'x-api-key': 'guess', cookie: 'session=1' },
      body: { name: 'bureau.tasks.inspect' },
    });
    const sent = bureau.mock.calls[0]?.[0] as Request;
    expect(sent.headers.get('authorization')).toBeNull();
    expect(sent.headers.get('x-api-key')).toBeNull();
    expect(sent.headers.get('cookie')).toBeNull();
    expect(sent.headers.get('origin')).toBeNull();
    const sentBody = (await sent.json()) as { params: { arguments: unknown } };
    expect(sentBody.params.arguments).toEqual({});
  });

  test('reads the result of an SSE answer', async () => {
    const bureau = mock(
      async (_request: Request) =>
        new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: RESULT })}\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    );
    const response = await call(routes(bureau), 'call', { body: { name: 'bureau.tasks.inspect' } });
    expect(await response.json()).toEqual(RESULT);
  });

  test('turns a JSON-RPC error into an error result that repeats nothing of the error', async () => {
    const bureau = bureauDouble({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'secret path /Users/someone/.bungalow' },
    });
    const response = await call(routes(bureau), 'call', { body: { name: 'bureau.tasks.inspect' } });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toContain('secret');
  });

  test('answers 502 when the Bureau answers something that is not a tools/call result', async () => {
    const bureau = mock(
      async (_request: Request) => new Response('<html>nope</html>', { status: 500 }),
    );
    const response = await call(routes(bureau), 'call', { body: { name: 'bureau.tasks.inspect' } });
    expect(response.status).toBe(502);
  });

  test.each([
    ['a toolbox tool', 'files.write'],
    ['a toolbox tool named like a Bureau tool’s prefix', 'bureau'],
    ['a Bureau tool the app did not declare', 'bureau.reviews.resolve'],
    ['a declared name in another case', 'BUREAU.TASKS.INSPECT'],
    ['a declared name with a space', 'bureau.tasks.inspect '],
    ['an inherited property name', 'constructor'],
  ])('refuses %s with 403 and runs nothing', async (_name, name) => {
    const bureau = bureauDouble();
    const response = await call(routes(bureau), 'call', { body: { name } });
    expect(response.status).toBe(403);
    expect(bureau).not.toHaveBeenCalled();
  });

  test('refuses a toolbox tool even when the app declared it', async () => {
    const bureau = bureauDouble();
    const table = routes(bureau, [app({ allowedTools: ['bureau.tasks.inspect', 'files.write'] })]);
    const response = await call(table, 'call', { body: { name: 'files.write' } });
    expect(response.status).toBe(403);
    expect(bureau).not.toHaveBeenCalled();
  });

  test.each([
    ['an unknown plugin', '/host/plugins/nobody/apps/run-inspector/tool-calls'],
    ['an unknown app', '/host/plugins/inspectors/apps/nothing/tool-calls'],
    ['an inherited plugin name', '/host/plugins/__proto__/apps/constructor/tool-calls'],
  ])('answers 404 for %s and runs nothing', async (_name, path) => {
    const bureau = bureauDouble();
    const response = await call(routes(bureau), 'call', {
      path,
      body: { name: 'bureau.tasks.inspect' },
    });
    expect(response.status).toBe(404);
    expect(bureau).not.toHaveBeenCalled();
  });

  test('refuses another app’s tool: each app has its own list', async () => {
    const bureau = bureauDouble();
    const table = routes(bureau, [
      app(),
      app({ name: 'pending-review', allowedTools: ['bureau.reviews.resolve'] }),
    ]);
    const response = await call(table, 'call', { body: { name: 'bureau.reviews.resolve' } });
    expect(response.status).toBe(403);
    expect(bureau).not.toHaveBeenCalled();
  });

  test.each([
    ['not JSON', 'not json'],
    ['an array', '[]'],
    ['without a name', '{}'],
    ['a name that is not a string', '{"name":7}'],
    ['arguments that are not an object', '{"name":"bureau.tasks.inspect","arguments":[]}'],
    ['arguments that are null', '{"name":"bureau.tasks.inspect","arguments":null}'],
  ])('refuses a body that is %s with 400 and runs nothing', async (_name, body) => {
    const bureau = bureauDouble();
    const response = await call(routes(bureau), 'call', { body });
    expect(response.status).toBe(400);
    expect(bureau).not.toHaveBeenCalled();
  });

  test.each([
    ['another origin', { origin: 'http://attacker.example' }],
    ['the string null origin', { origin: 'null' }],
    ['a rebound host name', { host: 'attacker.example' }],
  ])('runs no tool for a request from %s', async (_name, headers) => {
    const bureau = bureauDouble();
    const response = await call(routes(bureau), 'call', {
      headers,
      body: { name: 'bureau.tasks.inspect' },
    });
    expect(response.status).toBe(403);
    expect(bureau).not.toHaveBeenCalled();
  });
});
