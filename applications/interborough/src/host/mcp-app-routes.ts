/**
 * The host's routes behind a plugin's MCP-app panel (COR-1894). The run page mounts a panel through
 * Chat's `McpApp`, which owns no client and no credential, so the host supplies both halves of it:
 *
 * - `GET /host/mcp-apps` lists the panels the host serves: the plugin, the app, its title and
 *   `ui://` URI, and the Bureau tool it opens from. A page finds its panel here.
 * - `GET /host/plugins/<plugin>/apps/<app>` answers `{ html, ui }`, the built page and its
 *   deny-by-default security metadata, which is what `McpApp`'s resource loader returns. It is JSON
 *   on purpose: a navigation to an HTML answer would run the plugin's script as the top document
 *   of the host's origin, with none of the sandbox the panel gets inside `McpApp`.
 * - `POST /host/plugins/<plugin>/apps/<app>/tool-calls` with `{ "name": "...", "arguments": {} }`
 *   backs the panel's `onToolCall`. It runs only a tool the app declared in `allowedTools`, spelled
 *   exactly, and only a Bureau MCP tool (`bureau.*`); anything else answers 403 and reaches
 *   nothing. A declared tool becomes a JSON-RPC `tools/call` that goes in process to the Bureau's
 *   handler, as the local owner (a panel acts as the person who opened the page). The browser's
 *   headers are not forwarded, so no credential of the request reaches the Bureau. A panel never
 *   calls a toolbox tool, so approval policy and idempotency, which belong to a run, do not apply.
 *
 * Every route runs the request guard first, so a page on another origin gets no HTML and runs no
 * tool. An unknown plugin or app answers 404, a body that cannot be used answers 400, and a Bureau
 * that does not answer a `tools/call` result answers 502 with a message that repeats nothing.
 *
 * @module mcp-app-routes
 */
import { MCP_LEGACY_PROTOCOL_VERSION } from '@lostgradient/weft';

import { MCP_APP_UI_META, type ServedMcpApp } from './mcp-app-mounts.ts';
import { decoded } from './plugin-routes.ts';
import { BodyError, readObject } from './provider-routes.ts';

/** The route that lists the panels the host serves. */
export const HOST_MCP_APPS_ROUTE = '/host/mcp-apps';

/** The route that serves the page of the app it names. */
const HOST_MCP_APP_ROUTE = '/host/plugins/:name/apps/:app';

/** The route that runs a tool for the app it names. */
const HOST_MCP_APP_TOOL_CALLS_ROUTE = `${HOST_MCP_APP_ROUTE}/tool-calls`;

/** The only tools a panel reaches are the Bureau's own MCP tools. */
const BUREAU_TOOL_PREFIX = 'bureau.';

type Refuse = (request: Request) => Response | undefined;

/** Sends a request to the Bureau's handler, with the `/bureau` prefix already removed. */
export type CallBureau = (request: Request) => Promise<Response>;

const JSON_HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };

function refusal(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status, headers: JSON_HEADERS });
}

/** The first JSON-RPC message in a JSON answer, or in the `data:` lines of an event stream. */
function messageOf(text: string): unknown {
  const body = text.trimStart();
  if (body.startsWith('{')) return JSON.parse(body);
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice('data:'.length));
  }
  return undefined;
}

/** The `result` of a JSON-RPC answer to the one `tools/call` sent, or `undefined` for anything else. */
function toolResultOf(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  const result: unknown = Reflect.get(message, 'result');
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  return Object.fromEntries(Object.entries(result));
}

/**
 * The routes to merge into the host's `routes`. `apps` is what the host built at startup and
 * `callBureau` reaches the Bureau's handler.
 */
export function mcpAppRoutes(
  apps: readonly ServedMcpApp[],
  refuse: Refuse,
  callBureau: CallBureau,
) {
  // Snapshotted once, so nothing a caller does to the list afterwards changes what a panel may call.
  const served = apps.map((each) => ({ ...each, allowedTools: [...each.allowedTools] }));
  const find = (plugin: string, name: string) =>
    served.find((each) => each.plugin === plugin && each.name === name);

  async function callTool(
    request: Bun.BunRequest<typeof HOST_MCP_APP_TOOL_CALLS_ROUTE>,
  ): Promise<Response> {
    const app = find(decoded(request.params.name), decoded(request.params.app));
    if (app === undefined) return refusal(404, 'not-found', 'No such panel.');
    let body: Record<string, unknown>;
    try {
      body = await readObject(request);
    } catch (error) {
      if (!(error instanceof BodyError)) throw error;
      return refusal(400, 'invalid', error.message);
    }
    const name = body['name'];
    if (typeof name !== 'string') {
      return refusal(400, 'invalid', 'The request needs the name of a tool.');
    }
    const args = Object.hasOwn(body, 'arguments') ? body['arguments'] : {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return refusal(400, 'invalid', 'The arguments must be a JSON object.');
    }
    if (!name.startsWith(BUREAU_TOOL_PREFIX) || !app.allowedTools.includes(name)) {
      return refusal(403, 'forbidden-tool', 'This panel may not call that tool.');
    }
    // A request of the host's own making: none of the browser's headers, so none of its
    // credentials, and the Bureau serves it as the local owner.
    const mcpUrl = new URL('/mcp', request.url);
    const answer = await callBureau(
      new Request(mcpUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': MCP_LEGACY_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: Object.fromEntries(Object.entries(args)) },
        }),
        signal: request.signal,
      }),
    );
    let result: Record<string, unknown> | undefined;
    try {
      result = answer.ok ? toolResultOf(messageOf(await answer.text())) : undefined;
    } catch {
      result = undefined;
    }
    // Nothing the Bureau said is repeated: an error may hold a path or a value.
    if (result === undefined) return refusal(502, 'failed', 'The tool did not answer.');
    return Response.json(result, { headers: JSON_HEADERS });
  }

  return {
    [HOST_MCP_APPS_ROUTE]: {
      GET: (request: Request) =>
        refuse(request) ??
        Response.json(
          {
            apps: served.map(({ plugin, name, title, uri, opensFromTool }) => ({
              plugin,
              app: name,
              title,
              uri,
              opensFromTool,
            })),
          },
          { headers: JSON_HEADERS },
        ),
    },
    [HOST_MCP_APP_ROUTE]: {
      GET: (request: Bun.BunRequest<typeof HOST_MCP_APP_ROUTE>) => {
        const refused = refuse(request);
        if (refused !== undefined) return refused;
        const app = find(decoded(request.params.name), decoded(request.params.app));
        if (app === undefined) return refusal(404, 'not-found', 'No such panel.');
        return Response.json({ html: app.html, ui: MCP_APP_UI_META }, { headers: JSON_HEADERS });
      },
    },
    [HOST_MCP_APP_TOOL_CALLS_ROUTE]: {
      POST: (request: Bun.BunRequest<typeof HOST_MCP_APP_TOOL_CALLS_ROUTE>) =>
        refuse(request) ?? callTool(request),
    },
  };
}
