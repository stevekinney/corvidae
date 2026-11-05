import type { BureauResourceInventoryEntry, WorkspaceOperationClass } from '@lostgradient/bureau';
import { createLiveOperationRegistry, type ServeOptions } from '@lostgradient/weft';
import { routes as clientRoutes } from '../app/routes.ts';
import { ENGINE_PATH_PREFIXES } from './engine-proxy.ts';

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
  /** Wire transports reachable through this registered entry. */
  readonly transports: readonly ('http' | 'sse' | 'websocket')[];
}

const routeClasses: Readonly<Record<string, WorkspaceOperationClass>> = {
  'GET /host/providers': 'administrator-shared',
  'PUT /host/providers/:name': 'administrator-shared',
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
  'POST /host/restart': 'deployment-operator',
  'GET /host/storage': 'deployment-operator',
  'GET /host/paths': 'deployment-operator',
  'GET /__dev/reload': 'deployment-operator',
};

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
