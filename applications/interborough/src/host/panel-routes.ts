/**
 * The host's routes behind a plugin's panel (COR-1894). The run page mounts a panel through
 * Chat's `McpApp`, which owns no client and no credential, so the host supplies both halves of it:
 *
 * - `GET /host/panels` lists the panels the host serves: the plugin, the app, its title and
 *   `ui://` URI, the Bureau tool it opens from (left out when it names none), and its `placements`,
 *   the places it appears in the host (always listed, empty when it declares none). A page finds
 *   its panel here.
 * - `GET /host/plugins/<plugin>/apps/<app>` answers `{ html, ui }`, the built page and its
 *   deny-by-default security metadata, which is what `McpApp`'s resource loader returns. It is JSON
 *   on purpose: a navigation to an HTML answer would run the plugin's script as the top document
 *   of the host's origin, with none of the sandbox the panel gets inside `McpApp`.
 * - `POST /host/plugins/<plugin>/apps/<app>/tool-calls` with `{ "name": "...", "arguments": {} }`
 *   backs the panel's `onToolCall`. It runs only a tool the app declared in `allowedTools`, spelled
 *   exactly, and only a Bureau MCP tool (`bureau.*`); anything else answers 403 and reaches
 *   nothing. A declared tool becomes a JSON-RPC `tools/call` that goes in process to the Bureau's
 *   handler as its authenticated caller. A `hostOnlyTools` entry is not an MCP tool: it goes to the
 *   Bureau's `/jsonrpc` surface as a direct call of the operation, and only when the operation is
 *   in the Bureau's `HOST_PANEL_OPERATIONS`; any other host-only name answers 403 and the Bureau is
 *   never called (COR-2208). A host-only call runs inside Bureau's `runAsHostPanel` with the URI of
 *   the panel the host served, so the Bureau's audit entry names the panel (COR-2545); the URI is
 *   the host's own and travels in the call's in-process scope, never in a header or the body, so a
 *   page cannot name another panel's. Only authentication headers reach the in-process
 *   verifier; caller-selected identity and workspace headers are discarded. A panel never
 *   calls a toolbox tool, so approval policy and idempotency, which belong to a run, do not apply.
 *
 * Every route runs the request guard first, so a page on another origin gets no HTML and runs no
 * tool. An unknown plugin or app answers 404, a body that cannot be used answers 400, and a Bureau
 * that does not answer a `tools/call` result answers 502 with a message that repeats nothing.
 *
 * @module panel-routes
 */
import { HOST_PANEL_OPERATIONS, runAsHostPanel } from '@lostgradient/bureau';
import { MCP_LEGACY_PROTOCOL_VERSION } from '@lostgradient/weft';

import { MCP_APP_UI_META, type ServedPanel } from './panel-mounts.ts';
import { decoded } from './plugin-routes.ts';
import { BodyError, readObject } from './provider-routes.ts';

/** The route that lists the panels the host serves. */
export const HOST_PANELS_ROUTE = '/host/panels';

/** The route that serves the page of the app it names. */
const HOST_PANEL_ROUTE = '/host/plugins/:name/apps/:app';

/** The route that runs a tool for the app it names. */
const HOST_PANEL_TOOL_CALLS_ROUTE = `${HOST_PANEL_ROUTE}/tool-calls`;

/** The only tools a panel reaches are the Bureau's own MCP tools. */
const BUREAU_TOOL_PREFIX = 'bureau.';

type Refuse = (request: Request) => Response | undefined;

/** Sends a request to the Bureau's handler, with the `/bureau` prefix already removed. */
export type CallBureau = (request: Request) => Promise<Response>;

/** A host-side decision derived from the authenticated caller and the current review. */
export type PanelReviewEligibility = (
  request: Request,
  id: string,
  round: number,
  purpose: 'read' | 'resolve',
) => Promise<'ordinary' | 'authorized' | 'denied'>;

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

/** Turn a direct JSON-RPC fault into the same MCP result shape the panel already consumes. */
function toolErrorOf(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  const error: unknown = Reflect.get(message, 'error');
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return undefined;
  const code = Reflect.get(error, 'code');
  const messageText = Reflect.get(error, 'message');
  if (typeof code !== 'number' || typeof messageText !== 'string') return undefined;
  const data = Reflect.get(error, 'data');
  return {
    content: [{ type: 'text', text: messageText }],
    isError: true,
    ...(data === undefined ? {} : { structuredContent: data }),
    _rpc: { code },
  };
}

/**
 * The routes to merge into the host's `routes`. `apps` is what the host built at startup and
 * `callBureau` reaches the Bureau's handler.
 */
export function panelRoutes(
  apps: readonly ServedPanel[],
  refuse: Refuse,
  callBureau: CallBureau,
  reviewEligibility?: PanelReviewEligibility,
  browserCredentials?: (request: Request, name: string) => Promise<Headers | Response | undefined>,
) {
  // Snapshotted once, so nothing a caller does to the list afterwards changes what a panel may call.
  const served = apps.map((each) => ({ ...each, allowedTools: [...each.allowedTools] }));
  const find = (plugin: string, name: string) =>
    served.find((each) => each.plugin === plugin && each.name === name);

  async function callTool(
    request: Bun.BunRequest<typeof HOST_PANEL_TOOL_CALLS_ROUTE>,
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
    const reviewsPanel = app.uri === 'ui://inspectors/pending-review/v1';
    if (reviewsPanel && name === 'bureau.reviews.resolve') {
      const id = Object.hasOwn(args, 'id') ? Reflect.get(args, 'id') : undefined;
      const round = Object.hasOwn(args, 'round') ? Reflect.get(args, 'round') : undefined;
      if (
        Object.hasOwn(args, 'decisionSurface') ||
        typeof id !== 'string' ||
        id.length === 0 ||
        typeof round !== 'number' ||
        !Number.isSafeInteger(round) ||
        round < 0 ||
        !reviewEligibility ||
        (await reviewEligibility(request, id, round, 'resolve')) === 'denied'
      ) {
        return refusal(403, 'forbidden', 'This panel may not decide that review.');
      }
    }
    const hostOnly = app.hostOnlyTools.includes(name);
    // A host-only tool goes to `/jsonrpc`, which also answers operations no MCP client may call, so
    // a name outside the Bureau's list of operations open to host panels never reaches it, even
    // when a panel declared it (COR-2208).
    if (hostOnly && !HOST_PANEL_OPERATIONS.has(name)) {
      return refusal(403, 'forbidden-tool', 'This panel may not call that tool.');
    }
    const browserHeaders = reviewsPanel ? await browserCredentials?.(request, name) : undefined;
    if (browserHeaders instanceof Response) return browserHeaders;
    // Forward only verified browser credentials or explicit API credentials, never caller identity.
    const mcpUrl = new URL(hostOnly ? '/jsonrpc' : '/mcp', request.url);
    const toBureau = new Request(mcpUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': MCP_LEGACY_PROTOCOL_VERSION,
        ...Object.fromEntries(
          ['authorization', 'x-api-key'].flatMap((header) => {
            const value = request.headers.get(header);
            return value === null ? [] : [[header, value]];
          }),
        ),
        ...(browserHeaders === undefined ? {} : Object.fromEntries(browserHeaders)),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: hostOnly ? name : 'tools/call',
        params: hostOnly
          ? Object.fromEntries(Object.entries(args))
          : { name, arguments: Object.fromEntries(Object.entries(args)) },
      }),
      signal: request.signal,
    });
    // A host-only call names the panel it came through to the Bureau, for the audit trail
    // (COR-2545). The URI is the host's own, read from the panel it served; it travels in the
    // call's in-process scope and never in the request, so no client can name another panel's.
    const answer = await (hostOnly
      ? runAsHostPanel(app.uri, () => callBureau(toBureau))
      : callBureau(toBureau));
    let result: Record<string, unknown> | undefined;
    try {
      const responseText = await answer.text();
      const message = answer.ok ? messageOf(responseText) : undefined;
      const directResult = hostOnly ? toolResultOf(message) : undefined;
      result =
        directResult !== undefined && !Array.isArray(directResult['content'])
          ? {
              content: [{ type: 'text', text: JSON.stringify(directResult) }],
              structuredContent: directResult,
            }
          : (directResult ??
            toolResultOf(message) ??
            (hostOnly ? toolErrorOf(message) : undefined));
    } catch {
      result = undefined;
    }
    // Nothing the Bureau said is repeated: an error may hold a path or a value.
    if (result === undefined) return refusal(502, 'failed', 'The tool did not answer.');
    if (reviewsPanel && (name === 'bureau.reviews.list' || name === 'bureau.reviews.get')) {
      const content = result['structuredContent'];
      const value =
        content && typeof content === 'object' && !Array.isArray(content) ? content : undefined;
      const reviews =
        value && 'reviews' in value && Array.isArray(value.reviews) ? value.reviews : [value];
      const authorized: { id: string; round: number }[] = [];
      if (reviewEligibility && result['isError'] !== true) {
        for (const review of reviews) {
          if (
            !review ||
            typeof review !== 'object' ||
            !Object.hasOwn(review, 'id') ||
            !Object.hasOwn(review, 'round')
          )
            continue;
          const effect = Object.hasOwn(review, 'effect')
            ? Reflect.get(review, 'effect')
            : undefined;
          if (
            !effect ||
            typeof effect !== 'object' ||
            !Object.hasOwn(effect, 'kind') ||
            Reflect.get(effect, 'kind') !== 'refund'
          )
            continue;
          const id = Reflect.get(review, 'id');
          const round = Reflect.get(review, 'round');
          if (
            typeof id === 'string' &&
            id.length > 0 &&
            typeof round === 'number' &&
            Number.isSafeInteger(round) &&
            round >= 0 &&
            (await reviewEligibility(request, id, round, 'read')) === 'authorized'
          )
            authorized.push({ id, round });
        }
      }
      result['_meta'] = { 'interborough.reviewEligibility': authorized };
    }
    return Response.json(result, { headers: JSON_HEADERS });
  }

  return {
    [HOST_PANELS_ROUTE]: {
      GET: (request: Request) =>
        refuse(request) ??
        Response.json(
          {
            apps: served.map(({ plugin, name, title, uri, opensFromTool, placements }) => ({
              plugin,
              app: name,
              title,
              uri,
              ...(opensFromTool === undefined ? {} : { opensFromTool }),
              placements,
            })),
          },
          { headers: JSON_HEADERS },
        ),
    },
    [HOST_PANEL_ROUTE]: {
      GET: (request: Bun.BunRequest<typeof HOST_PANEL_ROUTE>) => {
        const refused = refuse(request);
        if (refused !== undefined) return refused;
        const app = find(decoded(request.params.name), decoded(request.params.app));
        if (app === undefined) return refusal(404, 'not-found', 'No such panel.');
        return Response.json({ html: app.html, ui: MCP_APP_UI_META }, { headers: JSON_HEADERS });
      },
    },
    [HOST_PANEL_TOOL_CALLS_ROUTE]: {
      POST: (request: Bun.BunRequest<typeof HOST_PANEL_TOOL_CALLS_ROUTE>) =>
        refuse(request) ?? callTool(request),
    },
  };
}
