/**
 * The A2A mount (COR-903): every published agent served over A2A 1.0.1 at
 * `<publicUrl>/a2a/<catalog-name>`, through Weft's kit (`createA2AHandler`) and Bureau's own
 * request handler (`a2a-request-handler.ts`).
 *
 * Each agent has its own interface: a JSON-RPC endpoint at its mount path, its public Agent Card
 * at `<path>/.well-known/agent-card.json`, and, when `signing` is set, the card-signing key at
 * `<path>/.well-known/jwks.json`. The card and key routes are served without credentials; every
 * other request has already been authenticated by the handler before it reaches the mount, and
 * a caller that can own nothing is refused.
 *
 * Publication is read on every request, so an agent published or withdrawn later is served or
 * refused without a restart: an agent that is not published has no card, starts no task, and
 * reads as not found.
 *
 * @module a2a-mount
 */

import type { OperationHandlerMount } from '@lostgradient/weft';
import {
  type A2AHandler,
  type A2ASecurityDeclaration,
  type A2ASigningOptions,
  createA2AHandler,
} from '@lostgradient/weft/a2a';

import { type A2AAgentCardSource, createBureauAgentCard } from './a2a-agent-card.ts';
import {
  type A2ABureau,
  type A2ASendLedger,
  type BureauA2ARequestHandlerOptions,
  BureauA2AUser,
  createBureauA2ARequestHandler,
} from './a2a-request-handler.ts';
import type { A2ATaskRecords } from './a2a-task-record.ts';
import { ownerOfPrincipal } from './owner-predicate.ts';

/** The path prefix every agent's A2A interface lives under. */
export const A2A_MOUNT_PREFIX = '/a2a';

const PUBLIC_ROUTE = /^\/a2a\/[^/]+\/\.well-known\/(?:agent-card|jwks)\.json$/;

/** The A2A options `createBureauHandler` accepts. */
export type BureauA2AOptions = {
  /** The handler's public origin and base path: an agent's interface is `<publicUrl>/a2a/<name>`. */
  readonly publicUrl: string;
  /** Base of the discovery URLs (a signed card's `jku`). Defaults to `publicUrl`. */
  readonly discoveryUrl?: string | undefined;
  /** Signs every card, and serves each agent's public key at `<path>/.well-known/jwks.json`. */
  readonly signing?: A2ASigningOptions | undefined;
};

/** What the mount reads beyond the Bureau itself. */
export type BureauA2AMountOptions = BureauA2AOptions & {
  readonly bureau: A2ABureau & { readonly id: string };
  readonly publication: { readonly includes: (agentName: string) => boolean };
  /** The card source of a catalog agent, or `undefined` when the catalog has none. */
  readonly describe: (agentName: string) => Omit<A2AAgentCardSource, 'security'> | undefined;
  /** The credentials the handler enforces; `undefined` when every request is the local caller. */
  readonly security: A2ASecurityDeclaration | undefined;
  readonly records: A2ATaskRecords;
  readonly ledger: A2ASendLedger;
  readonly respond: BureauA2ARequestHandlerOptions['respond'];
};

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function notFound(): Response {
  return Response.json({ error: 'Not found' }, { status: 404 });
}

/** Creates the mount that serves every published agent over A2A. */
export function createBureauA2AMount(options: BureauA2AMountOptions): OperationHandlerMount {
  const publicUrl = trimTrailingSlash(options.publicUrl);
  const discoveryUrl = trimTrailingSlash(options.discoveryUrl ?? options.publicUrl);
  // The user a request carries, keyed by the request the kit is handed, so its `authenticate`
  // reads back the principal the handler already resolved.
  const users = new WeakMap<Request, BureauA2AUser>();
  const handlers = new Map<string, { readonly revision: number; readonly handler: A2AHandler }>();

  function handlerOf(agentName: string): A2AHandler | undefined {
    const source = options.describe(agentName);
    if (source === undefined) return undefined;
    const held = handlers.get(agentName);
    if (held !== undefined && held.revision === source.definitionRevision) return held.handler;
    const agentCard = createBureauAgentCard({ ...source, security: options.security });
    const requestHandler = createBureauA2ARequestHandler({
      agentName,
      card: () => ({ ...agentCard, supportedInterfaces: [], signatures: [] }),
      bureau: options.bureau,
      records: options.records,
      ledger: options.ledger,
      respond: options.respond,
    });
    const handler = createA2AHandler({
      requestHandler,
      agentCard,
      publicUrl: `${publicUrl}${A2A_MOUNT_PREFIX}/${agentName}`,
      discoveryUrl: `${discoveryUrl}${A2A_MOUNT_PREFIX}/${agentName}`,
      tenant: options.bureau.id,
      authenticate: (request) =>
        users.get(request) ?? Response.json({ error: 'Unauthorized' }, { status: 401 }),
      ...(options.signing === undefined ? {} : { signing: options.signing }),
    });
    handlers.set(agentName, { revision: source.definitionRevision, handler });
    return handler;
  }

  return {
    pathPrefix: A2A_MOUNT_PREFIX,
    isPublicPath: (pathname) => PUBLIC_ROUTE.test(pathname),
    async fetch(request, context) {
      const pathname = new URL(request.url).pathname;
      const agentName = decodeURIComponent(pathname.split('/')[2] ?? '');
      if (agentName === '' || !options.publication.includes(agentName)) return notFound();
      const handler = handlerOf(agentName);
      if (handler === undefined) return notFound();
      if (!PUBLIC_ROUTE.test(pathname)) {
        if (ownerOfPrincipal(context.principal) === undefined) {
          return Response.json(
            { error: 'Serving A2A requires an API-key or local caller' },
            { status: 403 },
          );
        }
        users.set(request, new BureauA2AUser(context.principal));
      }
      return handler(request);
    },
  };
}
