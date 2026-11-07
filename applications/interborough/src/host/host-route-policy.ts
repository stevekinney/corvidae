import type { BureauResourceInventoryEntry, WorkspaceOperationClass } from '@lostgradient/bureau';
import { createLiveOperationRegistry, type ServeOptions } from '@lostgradient/weft';
import { routes as clientRoutes } from '../app/routes.ts';
import { ENGINE_PATH_PREFIXES } from './engine-proxy.ts';
import type { HostAuthority } from './host-authority.ts';
import type { HostSocketData } from './host-websocket.ts';

/** A live registered route and its policy; delegated routes enumerate their own child catalog. */
export interface HostRouteInventoryEntry {
  /** Registered HTTP method and path, or a named delegated relay. */
  readonly key: string;
  /** Policy class for this route; null means its children own the resource policy. */
  readonly resourceClass: WorkspaceOperationClass | null;
  /** Actual delegated operations and mounts registered beneath this route. */
  readonly children?: readonly BureauResourceInventoryEntry[];
  /** Exact URL prefixes forwarded to the delegated engine. */
  readonly pathPrefixes?: readonly string[];
  /** Whether authorization is applied by the child protocol handler. */
  readonly delegated: boolean;
  /** OAuth redirects prove authority through durable state and current initiating membership. */
  readonly admission?: 'durable-oauth-callback';
  /** Wire transports reachable through this registered entry. */
  readonly transports: readonly ('http' | 'sse' | 'websocket')[];
}

const routeClasses: Readonly<Record<string, WorkspaceOperationClass>> = {
  'GET /api/v1/principal': 'private-owned',
  // Interborough's own API (COR-2019) answers as the local person, so it is a deployment operation:
  // a workspace member is refused before the handler, whose scopes are checked there too.
  'GET /api/runs': 'deployment-operator',
  'POST /api/runs': 'deployment-operator',
  'GET /api/runs/:run': 'deployment-operator',
  'POST /api/chats/:chat/messages': 'deployment-operator',
  'GET /api/agents': 'deployment-operator',
  'GET /api/schedules': 'deployment-operator',
  'POST /api/reviews/:review/decision': 'deployment-operator',
  'GET /api/openapi.json': 'deployment-operator',
  'GET /host/session': 'deployment-operator',
  'GET /host/providers': 'administrator-shared',
  'PUT /host/providers/:name': 'administrator-shared',
  'POST /host/providers/:name/test': 'administrator-shared',
  'DELETE /host/providers/:name': 'administrator-shared',
  'POST /host/providers/reload': 'administrator-shared',
  'PUT /host/catalog': 'administrator-shared',
  'GET /host/plugins': 'administrator-shared',
  'PUT /host/plugins/:name': 'administrator-shared',
  'PUT /host/plugins/:name/secrets/:key': 'administrator-shared',
  'GET /host/clean-up': 'deployment-operator',
  'POST /host/clean-up': 'deployment-operator',
  'GET /host/mcp-apps': 'member-shared-read',
  'GET /host/plugins/:name/apps/:app': 'member-shared-read',
  'POST /host/plugins/:name/apps/:app/tool-calls': 'private-owned',
  'PUT /host/skills/sources/:id/trust': 'deployment-operator',
  'POST /host/skills/refresh': 'deployment-operator',
  'GET /host/tool-sources': 'administrator-shared',
  'PUT /host/tool-sources/:id': 'administrator-shared',
  'DELETE /host/tool-sources/:id': 'administrator-shared',
  'POST /host/tool-sources/:id/probe': 'administrator-shared',
  'GET /host/tool-sources/:id/affected-agents': 'administrator-shared',
  'PUT /host/tool-sources/:id/tools': 'administrator-shared',
  'POST /host/openapi-inspection': 'administrator-shared',
  'POST /host/tool-sources/:id/authorize': 'administrator-shared',
  'GET /host/oauth/callback/:id': 'administrator-shared',
  'GET /host/restart': 'deployment-operator',
  'GET /host/status': 'deployment-operator',
  'POST /host/restart': 'deployment-operator',
  'GET /host/storage': 'deployment-operator',
  'GET /host/storage/summary': 'deployment-operator',
  'GET /host/paths': 'deployment-operator',
  'GET /__dev/reload': 'deployment-operator',
};

type HostHandler = (
  request: Request,
  server: Bun.Server<HostSocketData>,
) => Promise<Response | undefined>;

/** Guard the actual registered handlers with the same inventory used by conformance tests. */
export function authorizeHostRoutes(
  routes: Readonly<Record<string, unknown>>,
  authority: HostAuthority,
  refuse: (request: Request) => Response | undefined,
): Record<string, HostHandler | Record<string, HostHandler>> {
  const inventory = inventoryHostRoutes(routes);
  const guarded: Record<string, HostHandler | Record<string, HostHandler>> = {};
  const wrap = (
    handler: unknown,
    classification: WorkspaceOperationClass | null,
    admission?: 'durable-oauth-callback',
  ): HostHandler => {
    if (typeof handler !== 'function') throw new TypeError('Host routes require handlers');
    return async (request, server) => {
      if (classification !== null) {
        const refusal = refuse(request);
        if (refusal !== undefined) return refusal;
      }
      if (
        admission === undefined &&
        classification !== null &&
        classification !== 'public-discovery'
      ) {
        const refusal = await authority.authorize(request, classification);
        if (refusal !== undefined) return refusal;
      }
      const response: unknown = await Reflect.apply(handler, undefined, [request, server]);
      if (response !== undefined && !(response instanceof Response))
        throw new TypeError('Host handler returned an invalid response');
      return response !== undefined &&
        classification !== null &&
        classification !== 'public-discovery' &&
        admission === undefined
        ? authority.release(request, classification, response)
        : response;
    };
  };
  for (const [path, handlers] of Object.entries(routes)) {
    if (typeof handlers === 'function') {
      guarded[path] = wrap(handlers, null);
      continue;
    }
    if (handlers === null || typeof handlers !== 'object')
      throw new TypeError('Invalid host routes');
    const methods: Record<string, HostHandler> = {};
    for (const [method, handler] of Object.entries(handlers)) {
      const entry = inventory.find((candidate) => candidate.key === `${method} ${path}`);
      if (entry === undefined) throw new TypeError('Unclassified host route');
      methods[method] = wrap(handler, entry.resourceClass, entry.admission);
    }
    guarded[path] = methods;
  }
  return guarded;
}

/** Capture the exact object passed to Bun; a new route or method must explicitly declare policy. */
export function inventoryHostRoutes(
  routes: Readonly<Record<string, unknown>>,
  bureauChildren: readonly BureauResourceInventoryEntry[] = [],
): readonly HostRouteInventoryEntry[] {
  const shells = new Set(clientRoutes.map((route) => route.pattern));
  const entries: HostRouteInventoryEntry[] = [];
  for (const [path, handlers] of Object.entries(routes)) {
    if (path === '/bureau/*' && typeof handlers === 'function') {
      entries.push({
        key: '* /bureau/*',
        resourceClass: null,
        children: bureauChildren,
        delegated: true,
        transports: ['http', 'sse', 'websocket'],
      });
      continue;
    }
    if (handlers === null || typeof handlers !== 'object')
      throw new TypeError(`Unclassified host route ${path}`);
    for (const method of Object.keys(handlers)) {
      const key = `${method} ${path}`;
      const resourceClass =
        method === 'GET' && (path === '/assets/*' || shells.has(path))
          ? 'public-discovery'
          : Object.hasOwn(routeClasses, key)
            ? routeClasses[key]
            : undefined;
      if (resourceClass === undefined) throw new TypeError(`Unclassified host route ${key}`);
      entries.push(
        Object.freeze({
          key,
          resourceClass,
          delegated: false,
          ...(key === 'GET /host/oauth/callback/:id'
            ? { admission: 'durable-oauth-callback' as const }
            : {}),
          transports: Object.freeze(
            path === '/__dev/reload' ? (['sse'] as const) : (['http'] as const),
          ),
        }),
      );
    }
  }
  return Object.freeze(entries.sort((a, b) => a.key.localeCompare(b.key)));
}

/** The relay is a separate deployment plane, including operations hidden from public discovery. */
export function inventoryEngineRelay(
  options: Pick<ServeOptions, 'operations' | 'routes'> = {},
): HostRouteInventoryEntry {
  const registry = createLiveOperationRegistry(
    options.operations === undefined ? {} : { additionalOperations: options.operations },
  );
  const children: BureauResourceInventoryEntry[] = registry.list().map((operation) => ({
    kind: 'operation',
    key: operation.name,
    workspaceClass: 'deployment-operator',
    transports: Object.entries(operation.transports)
      .filter(([, available]) => available)
      .map(([transport]) => transport),
  }));
  for (const path of Object.keys(options.routes ?? {})) {
    children.push({
      kind: 'mount',
      key: path,
      workspaceClass: 'deployment-operator',
      transports: ['http'],
    });
  }
  return Object.freeze({
    key: '* engine-proxy',
    resourceClass: 'deployment-operator',
    delegated: true,
    children: Object.freeze(children),
    pathPrefixes: ENGINE_PATH_PREFIXES,
    transports: ['http', 'sse', 'websocket'] as const,
  });
}
