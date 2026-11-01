/**
 * The host's routes for saved tool sources (`tool-source-manager.ts`):
 *
 * - `GET /host/tool-sources` reports each configured source, where it stands (`loaded`, `failed`,
 *   `needs-authorization`, `pending-restart`), the tools it offers under the names an agent file
 *   uses, and the names of its stored credentials. It never carries a credential or a URL.
 * - `PUT /host/tool-sources/<id>` with `{ "source": { … }, "credentials": { "<name>": "<value>" } }`
 *   connects a source, or replaces it. `source` is Armorer's description and its `id` must be `<id>`.
 *   A credential the description names and the host already holds may be left out.
 * - `POST /host/tool-sources/<id>/probe` with the same body as the `PUT` contacts a source that is not
 *   saved, with the credentials in the body and none from the host's vault, and answers 200 with
 *   `{ "outcome": "listed", "tools": [{ "name", "tool", "tier" }], "skipped": […] }`, or
 *   `{ "outcome": "needs-authorization" }` for an OAuth server that asks for a sign-in, or
 *   `{ "outcome": "failed", "message": "…" }` for a source that did not answer as it should, in
 *   words that hold no address, command or value. It saves nothing and keeps no connection. A
 *   request that cannot be used answers as the `PUT` does, and a local command is spawned only for
 *   the owner.
 * - `PUT /host/tool-sources/<id>/tools` with `{ "tools": { "<tool>": { "acceptsSecrets": true } } }`
 *   sets the host's own settings for the named tools of a configured source (COR-1932). `<tool>` is
 *   the tool's own name as the server lists it, not the `<id>__<tool>` name. Each named tool's
 *   settings are replaced and the others kept; `false` (or `{}`) removes the entry, since off is
 *   the default. A name the server does not list is accepted and reported by `GET` under the
 *   source's `unmatchedSettings`. The change loads at the next start; remote mode answers 403
 *   `deployment` like every other change here.
 * - `GET /host/tool-sources/<id>/affected-agents` lists the agent files that name the source's
 *   tools, in `tools` or only in `toolApproval`, and changes nothing. A source the configuration
 *   does not list answers 404.
 * - `DELETE /host/tool-sources/<id>` removes a source and clears its credentials. It answers the
 *   same list as `affectedAgents`: those agent files are not edited, and read `invalid` with
 *   `unknown-tool` once the host starts again, until the owner detaches the tool.
 * - `POST /host/tool-sources/<id>/authorize` starts an MCP OAuth sign-in and answers with the
 *   authorization URL to open (`{ "authorized": false, "authorizationUrl": "…" }`), or
 *   `{ "authorized": true }` when the stored tokens already work.
 * - `GET /host/oauth/callback/<id>` is where the authorization server sends the browser back. It
 *   answers a small page, never JSON, and never repeats a parameter of the request.
 *
 * Every answer but the callback's is JSON. A change answers 200 with `{ id, changed,
 * restartRequired: true }` (a removal adds `affectedAgents`): the source's tools are listed when the host starts again. A refusal
 * because the home is remote answers 403 with `reason: "deployment"`; a local command asked for by
 * anyone but the owner answers 403 with `error: "owner-only"`; a source the configuration does not
 * list answers 404; a request or configuration that cannot be used answers 400 naming the field;
 * a change that was applied but not recorded in the audit trail, or left half done, answers 500
 * with `error: "partial"`; anything else answers 500 with a message that names no value.
 *
 * @module tool-source-routes
 */

import { ProviderConfigurationError } from './provider-configuration-error.ts';
import {
  HOST_OAUTH_CALLBACK_ROUTE,
  ToolSourceAuditError,
  ToolSourceInputError,
  ToolSourceOwnerOnlyError,
  ToolSourcePartialChangeError,
  ToolSourceWriteLockedError,
  type ToolSourceManager,
} from './tool-source-manager.ts';
import { ToolSourceSecretsLockedError } from './tool-source-vault.ts';

/** The route that lists the saved tool sources. */
export const HOST_TOOL_SOURCES_ROUTE = '/host/tool-sources';

/** The route that connects or removes the source it names. */
export const HOST_TOOL_SOURCE_ROUTE = `${HOST_TOOL_SOURCES_ROUTE}/:id`;

/** The route that lists the agent files a removal of the source it names would leave invalid. */
export const HOST_TOOL_SOURCE_AFFECTED_AGENTS_ROUTE = `${HOST_TOOL_SOURCES_ROUTE}/:id/affected-agents`;

/** The route that contacts a source before it is saved. */
export const HOST_TOOL_SOURCE_PROBE_ROUTE = `${HOST_TOOL_SOURCES_ROUTE}/:id/probe`;

/** The route that sets the host's per-tool settings of the source it names. */
export const HOST_TOOL_SOURCE_TOOLS_ROUTE = `${HOST_TOOL_SOURCES_ROUTE}/:id/tools`;

/** The route that starts the sign-in of the source it names. */
export const HOST_TOOL_SOURCE_AUTHORIZE_ROUTE = `${HOST_TOOL_SOURCES_ROUTE}/:id/authorize`;

export { HOST_OAUTH_CALLBACK_ROUTE };

/** The largest request body the tool-source routes read: a description may embed an OpenAPI document. */
const MAXIMUM_BODY_BYTES = 4 * 1024 * 1024;

type Refuse = (request: Request) => Response | undefined;

/** A request body that is not JSON of the expected shape. The message names the body, never its contents. */
class BodyError extends Error {}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAXIMUM_BODY_BYTES) throw new BodyError('The request body is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError('The request body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BodyError('The request body must be a JSON object.');
  }
  return Object.fromEntries(Object.entries(parsed));
}

/** The refusal an error stands for, or `undefined` for one the routes do not know. */
function refusalOf(error: unknown): Response | undefined {
  if (error instanceof ToolSourceWriteLockedError) {
    return Response.json(
      { error: 'locked', reason: error.reason, message: error.message },
      { status: 403 },
    );
  }
  if (error instanceof ToolSourceSecretsLockedError) {
    return Response.json(
      { error: 'locked', reason: 'deployment', message: error.message },
      { status: 403 },
    );
  }
  if (error instanceof ToolSourceOwnerOnlyError) {
    return Response.json({ error: 'owner-only', message: error.message }, { status: 403 });
  }
  if (error instanceof ToolSourceInputError) {
    const unknown = error.kind === 'unknown-source';
    return Response.json(
      { error: unknown ? 'not-found' : 'invalid', field: error.field, message: error.message },
      { status: unknown ? 404 : 400 },
    );
  }
  if (error instanceof ProviderConfigurationError) {
    return Response.json(
      { error: 'invalid', field: error.field, message: error.message },
      { status: 400 },
    );
  }
  if (error instanceof BodyError) {
    return Response.json(
      { error: 'invalid', field: 'body', message: error.message },
      { status: 400 },
    );
  }
  if (error instanceof ToolSourcePartialChangeError) {
    return Response.json(
      { error: 'partial', source: error.sourceId, stage: error.stage, message: error.message },
      { status: 500 },
    );
  }
  if (error instanceof ToolSourceAuditError) {
    return Response.json(
      { error: 'partial', source: error.sourceId, stage: 'not-audited', message: error.message },
      { status: 500 },
    );
  }
  return undefined;
}

/** Run `work` and answer with its result, or with the refusal its error stands for. */
async function respond(work: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await work());
  } catch (error) {
    // Nothing from an unknown failure is repeated: it may hold a path, a URL, or a value.
    return (
      refusalOf(error) ??
      Response.json(
        { error: 'failed', message: 'The tool source configuration could not be changed.' },
        { status: 500 },
      )
    );
  }
}

const CALLBACK_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // The address holds the authorization code. It must go nowhere, and be kept nowhere.
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

function callbackPage(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${body}</p></body></html>`,
    { status, headers: CALLBACK_HEADERS },
  );
}

/** What the routes read besides the manager. */
export type ToolSourceRoutesOptions = {
  /** The principal a request acts as. A local command is added only when it is the owner. */
  readonly principal: (request: Request) => string;
};

/** The routes to merge into the host's `routes`. Each runs the guard first. */
export function toolSourceRoutes(
  manager: ToolSourceManager,
  refuse: Refuse,
  options: ToolSourceRoutesOptions,
) {
  return {
    [HOST_TOOL_SOURCES_ROUTE]: {
      GET: (request: Request) => refuse(request) ?? respond(() => manager.snapshot()),
    },
    [HOST_TOOL_SOURCE_ROUTE]: {
      PUT: (request: Bun.BunRequest<typeof HOST_TOOL_SOURCE_ROUTE>) =>
        refuse(request) ??
        respond(async () => {
          const body = await readObject(request);
          return manager.connect({
            id: request.params.id,
            source: body['source'],
            credentials: body['credentials'],
            principal: options.principal(request),
          });
        }),
      DELETE: (request: Bun.BunRequest<typeof HOST_TOOL_SOURCE_ROUTE>) =>
        refuse(request) ??
        respond(() =>
          manager.remove({ id: request.params.id, principal: options.principal(request) }),
        ),
    },
    [HOST_TOOL_SOURCE_PROBE_ROUTE]: {
      POST: (request: Bun.BunRequest<typeof HOST_TOOL_SOURCE_PROBE_ROUTE>) =>
        refuse(request) ??
        respond(async () => {
          const body = await readObject(request);
          return manager.probe({
            id: request.params.id,
            source: body['source'],
            credentials: body['credentials'],
            principal: options.principal(request),
          });
        }),
    },
    [HOST_TOOL_SOURCE_AFFECTED_AGENTS_ROUTE]: {
      GET: (request: Bun.BunRequest<typeof HOST_TOOL_SOURCE_AFFECTED_AGENTS_ROUTE>) =>
        refuse(request) ?? respond(() => manager.affectedAgents(request.params.id)),
    },
    [HOST_TOOL_SOURCE_TOOLS_ROUTE]: {
      PUT: (request: Bun.BunRequest<typeof HOST_TOOL_SOURCE_TOOLS_ROUTE>) =>
        refuse(request) ??
        respond(async () => {
          const body = await readObject(request);
          return manager.configureTools({ id: request.params.id, tools: body['tools'] });
        }),
    },
    [HOST_TOOL_SOURCE_AUTHORIZE_ROUTE]: {
      POST: (request: Bun.BunRequest<typeof HOST_TOOL_SOURCE_AUTHORIZE_ROUTE>) =>
        refuse(request) ?? respond(() => manager.authorize(request.params.id)),
    },
    [HOST_OAUTH_CALLBACK_ROUTE]: {
      GET: async (request: Bun.BunRequest<typeof HOST_OAUTH_CALLBACK_ROUTE>) => {
        const refusal = refuse(request);
        if (refusal !== undefined) return refusal;
        try {
          await manager.completeAuthorization(request.params.id, request.url);
          return callbackPage(
            'Signed in',
            'Signed in. Close this tab and restart Interborough to list the source’s tools.',
            200,
          );
        } catch (error) {
          const refused = refusalOf(error);
          // The page says that it failed and nothing about why: the address holds a code.
          return callbackPage(
            'Sign-in failed',
            refused?.status === 403
              ? 'Signing in is not allowed on this host.'
              : 'The sign-in could not be completed. Start it again from Interborough.',
            refused?.status === 403 ? 403 : 400,
          );
        }
      },
    },
  };
}
