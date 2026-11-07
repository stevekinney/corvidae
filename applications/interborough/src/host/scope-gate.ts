/**
 * The scopes of Interborough's API (`src/lib/api-scopes.ts`) checked on the operations Interborough's
 * own pages call, beside the seven `/api` operations that check them in `api-routes.ts`
 * (decisions.md, "B11 after round 3": the ten are enforced on those routes and on the matching
 * Interborough operations).
 *
 * - The Bureau's management plane, `POST /bureau/jsonrpc`: each method in {@link BUREAU_METHOD_SCOPES}
 *   needs its scope, in a single request or in any entry of a batch.
 * - The Bureau's MCP tools, `POST /bureau/mcp`: a `tools/call` of a tool the same table names. A
 *   Bureau MCP tool is named by its operation, so one table serves both.
 * - Chat's AG-UI runs: `POST /bureau/ag-ui/agents/<name>/run` sends a message (`chats:write`), and
 *   `POST /bureau/ag-ui/runs/<run>/cancel` cancels a run (`runs:write`).
 * - The host's own settings routes: every write to `/host/plugins…` and `/host/providers…` needs
 *   `settings:write` ({@link refuseWritesWithoutScope}).
 *
 * The Bureau's other transports reach none of these operations: the methods the table names are
 * served over JSON-RPC on HTTP alone (only event subscriptions take the WebSocket or a plain HTTP
 * route), and the only ones the MCP mount exposes are reads, `bureau.tasks.cancel`,
 * `bureau.contexts.input` and `bureau.reviews.resolve`, which the table names. A2A, which a remote
 * agent reaches with its own key, is not one of Interborough's pages and is not checked here.
 *
 * The Bureau itself still serves every request as the local owner holding every Bureau scope; this
 * check stands in front of it. A session holding every scope, which is every session while
 * Interborough is single-user, is let through before its body is read. A refusal never reaches the
 * Bureau, and names the scope it lacked.
 *
 * @module scope-gate
 */
import { API_SCOPES, type ApiScope } from '../lib/api-scopes.ts';
import type { ApiPrincipal } from './api-routes.ts';

/**
 * Every Bureau operation a scope gates, by the operation's name, which is its JSON-RPC method and
 * its MCP tool's name alike. An operation not named here needs no scope of Interborough's API.
 */
export const BUREAU_METHOD_SCOPES: ReadonlyMap<string, ApiScope> = new Map<string, ApiScope>([
  ['bureau.workflows.runs.list', 'runs:read'],
  ['bureau.workflows.runs.get', 'runs:read'],
  ['bureau.tasks.list', 'runs:read'],
  ['bureau.tasks.get', 'runs:read'],
  ['bureau.tasks.inspect', 'runs:read'],
  ['bureau.workflows.start', 'runs:write'],
  ['bureau.workflows.signal', 'runs:write'],
  ['bureau.tasks.cancel', 'runs:write'],
  ['bureau.contexts.input', 'chats:write'],
  ['bureau.contexts.steer', 'chats:write'],
  ['bureau.reviews.resolve', 'reviews:write'],
  ['bureau.agents.list', 'agents:read'],
  ['bureau.agents.definitions.list', 'agents:read'],
  ['bureau.agents.definitions.get', 'agents:read'],
  ['bureau.schedules.list', 'schedules:read'],
  ['bureau.schedules.get', 'schedules:read'],
  ['bureau.schedules.missed', 'schedules:read'],
  ['bureau.schedules.create', 'schedules:write'],
  ['bureau.schedules.update', 'schedules:write'],
  ['bureau.schedules.pause', 'schedules:write'],
  ['bureau.schedules.resume', 'schedules:write'],
  ['bureau.schedules.skipnext', 'schedules:write'],
  ['bureau.schedules.unskip', 'schedules:write'],
  ['bureau.schedules.runnow', 'schedules:write'],
  ['bureau.schedules.cancel', 'schedules:write'],
  ['bureau.agents.definitions.create', 'agents:write'],
  ['bureau.agents.definitions.update', 'agents:write'],
  ['bureau.agents.definitions.duplicate', 'agents:write'],
  ['bureau.agents.definitions.delete', 'agents:write'],
  ['bureau.agents.versions.restore', 'agents:write'],
  ['bureau.agents.overrides.update', 'agents:write'],
  ['bureau.hooks.create', 'hooks:write'],
  ['bureau.hooks.update', 'hooks:write'],
  ['bureau.hooks.delete', 'hooks:write'],
  ['bureau.hooks.secret.replace', 'hooks:write'],
  ['bureau.hooks.test', 'hooks:write'],
  ['bureau.settings.update', 'settings:write'],
]);

/** The Bureau's JSON-RPC path, with the `/bureau` prefix removed. */
const JSON_RPC_PATH = '/jsonrpc';

/** The Bureau's MCP path, with the `/bureau` prefix removed. */
const MCP_PATH = '/mcp';

/** Chat's AG-UI routes that change something, with the `/bureau` prefix removed, and their scopes. */
const AG_UI_SCOPES: readonly { readonly pattern: RegExp; readonly scope: ApiScope }[] = [
  { pattern: /^\/ag-ui\/agents\/[^/]+\/run\/?$/u, scope: 'chats:write' },
  { pattern: /^\/ag-ui\/runs\/[^/]+\/cancel\/?$/u, scope: 'runs:write' },
];

/** The JSON-RPC error code Weft answers a `Forbidden` fault with. */
const FORBIDDEN_CODE = -32011;

/** Whether `principal` holds every scope, so nothing it asks for can be refused. */
function holdsEveryScope(principal: ApiPrincipal): boolean {
  return API_SCOPES.every((scope) => principal.scopes.has(scope));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The operation one JSON-RPC message names: its method, or the tool an MCP `tools/call` names. */
function operationOf(message: Record<string, unknown>, path: string): string | undefined {
  const method = message['method'];
  if (typeof method !== 'string') return undefined;
  if (path !== MCP_PATH) return method;
  if (method !== 'tools/call' || !isRecord(message['params'])) return undefined;
  const name = message['params']['name'];
  return typeof name === 'string' ? name : undefined;
}

/** The scope `principal` lacks for one JSON-RPC message, if it lacks one. */
function missingScopeOf(
  message: unknown,
  path: string,
  principal: ApiPrincipal,
): ApiScope | undefined {
  if (!isRecord(message)) return undefined;
  const operation = operationOf(message, path);
  if (operation === undefined) return undefined;
  const scope = BUREAU_METHOD_SCOPES.get(operation);
  return scope === undefined || principal.scopes.has(scope) ? undefined : scope;
}

/** A JSON-RPC error refusing one message, in the envelope Weft answers a `Forbidden` fault with. */
function forbiddenMessage(id: unknown, scope: ApiScope): Record<string, unknown> {
  const reason = `This session does not hold ${scope}.`;
  return {
    jsonrpc: '2.0',
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: {
      code: FORBIDDEN_CODE,
      message: reason,
      data: { reason, scope, weftCode: 'Forbidden', httpStatus: 403 },
    },
  };
}

/** The refusal of a JSON-RPC request, or `undefined` when the principal may send all of it. */
function jsonRpcRefusal(
  body: unknown,
  path: string,
  principal: ApiPrincipal,
): Response | undefined {
  if (Array.isArray(body)) {
    const missing = body.map((message) => missingScopeOf(message, path, principal));
    const first = missing.find((scope) => scope !== undefined);
    if (first === undefined) return undefined;
    // A batch is answered whole: none of it reaches the Bureau when any entry may not, so a batch
    // never half-runs. Each request in it is refused with the scope it lacks, or the first one the
    // batch lacks; a notification gets no answer, as JSON-RPC has it.
    const answers = body.flatMap((message: unknown, index) =>
      isRecord(message) && Object.hasOwn(message, 'id')
        ? [forbiddenMessage(message['id'], missing[index] ?? first)]
        : [],
    );
    return answers.length === 0 ? new Response(null, { status: 204 }) : Response.json(answers);
  }
  const scope = missingScopeOf(body, path, principal);
  if (scope === undefined) return undefined;
  if (!isRecord(body) || !Object.hasOwn(body, 'id')) return new Response(null, { status: 204 });
  return Response.json(forbiddenMessage(body['id'], scope));
}

/** The answer to an AG-UI route the principal may not call. */
function routeRefusal(scope: ApiScope): Response {
  return Response.json(
    { error: 'forbidden', message: `This session does not hold ${scope}.`, scope },
    { status: 403 },
  );
}

/**
 * The refusal of a request to the Bureau that needs a scope `principal` does not hold, or
 * `undefined` to send it on. `request` is the Bureau's, with the `/bureau` prefix removed. Its body
 * is read from a clone, so the request itself is still unread when it goes on, and a body that is
 * not JSON goes on for the Bureau to answer.
 */
export async function bureauScopeRefusal(
  request: Request,
  principal: ApiPrincipal,
): Promise<Response | undefined> {
  if (holdsEveryScope(principal) || request.method !== 'POST') return undefined;
  const path = new URL(request.url).pathname;
  for (const { pattern, scope } of AG_UI_SCOPES) {
    if (pattern.test(path)) return principal.scopes.has(scope) ? undefined : routeRefusal(scope);
  }
  if (path !== JSON_RPC_PATH && path !== MCP_PATH) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(await request.clone().text()) as unknown;
  } catch {
    return undefined;
  }
  return jsonRpcRefusal(body, path, principal);
}

/** The host's request guard: a refusal, or `undefined` to serve the request. */
export type Refuse = (request: Request) => Response | undefined;

/** The methods that only read, which a write scope never gates. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * The request guard `refuse` that also refuses a write, any method but `GET` or `HEAD`, from a
 * principal without `scope`: after the guard's own answer, the write is answered `403` with the
 * scope it lacks, and the route's handler, which asks the guard first, never runs. The host hands
 * it to its plugin and provider routes with `settings:write`.
 */
export function refuseWritesWithoutScope(
  refuse: Refuse,
  scope: ApiScope,
  principal: (request: Request) => ApiPrincipal,
): Refuse {
  return (request) => {
    const refusal = refuse(request);
    if (refusal !== undefined || READ_METHODS.has(request.method)) return refusal;
    return principal(request).scopes.has(scope) ? undefined : routeRefusal(scope);
  };
}
