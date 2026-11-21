import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ClientRouteManifest,
  RouteEntry,
  RouteManifest,
  RouteMatch,
  RouteModules,
  RouteMatchers,
  RouteNode,
} from "./manifest-types.ts";
import { matchRoute } from "./match.ts";
import { parseRoute, RouteDiagnostic, urlSegments } from "./grammar.ts";
import { rejectConflicts, RouteConflict, sortRoutes } from "./route-order.ts";
export {
  isRouteParameterValue,
  matchRoute,
  RouteMatcherError,
} from "./match.ts";
export type {
  RouteMatcher,
  RouteMatchers,
  RouteParameterValue,
} from "./manifest-types.ts";

type FileRole = {
  role: "page" | "layout" | "error" | "endpoint";
  kind: keyof RouteModules;
  namedParent?: string;
};
const fileRoles: Record<string, FileRole> = {
  "+page.svelte": { role: "page", kind: "component" },
  "+page.ts": { role: "page", kind: "universal" },
  "+page.js": { role: "page", kind: "universal" },
  "+page.server.ts": { role: "page", kind: "server" },
  "+page.server.js": { role: "page", kind: "server" },
  "+layout.svelte": { role: "layout", kind: "component" },
  "+layout.ts": { role: "layout", kind: "universal" },
  "+layout.js": { role: "layout", kind: "universal" },
  "+layout.server.ts": { role: "layout", kind: "server" },
  "+layout.server.js": { role: "layout", kind: "server" },
  "+error.svelte": { role: "error", kind: "component" },
  "+server.ts": { role: "endpoint", kind: "server" },
  "+server.js": { role: "endpoint", kind: "server" },
};
const posix = (value: string) => value.split(sep).join("/");
const idFor = (directory: string) => (directory ? `/${directory}` : "/");
const componentRole = (name: string): FileRole | undefined => {
  const match = /^\+(page|layout)@(.*)\.svelte$/.exec(name);
  if (!match) return undefined;
  return {
    role: match[1] as "page" | "layout",
    kind: "component",
    namedParent: match[2],
  };
};
const routeFileRole = (name: string, source: string): FileRole => {
  const component = componentRole(name);
  if (component) return component;
  if (/^\+(?:page|layout)@.*\.(?:ts|js)$/.test(name))
    throw new Error(
      `${source}: named layout references are only supported on component files`,
    );
  const role = fileRoles[name];
  if (!role) throw new Error(`${source}: unsupported route file role ${name}`);
  return role;
};
const segmentOf = (node: RouteNode) => node.directory.split("/").at(-1) ?? "";

/** Discover every source role and physical ancestor into the canonical, serializable manifest. */
export async function buildRouteManifest(
  routesDirectory: string,
  options: { matcherModule?: string } = {},
): Promise<RouteManifest> {
  const root = resolve(routesDirectory);
  const requestedMatcherModule = options.matcherModule;
  const matcherModule = requestedMatcherModule
    ? resolve(requestedMatcherModule)
    : undefined;
  let activeMatcherModule: string | undefined;
  const referencedMatchers = new Set<string>();
  const directories = new Map<string, string[]>([["", []]]);
  const discoveredPaths = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true }),
  );
  const paths = discoveredPaths.toSorted();
  for (const path of paths) {
    const name = basename(path);
    if (!name.startsWith("+")) continue;
    routeFileRole(name, resolve(root, path));
    let directory = posix(relative(root, dirname(resolve(root, path))));
    const files = directories.get(directory) ?? [];
    files.push(posix(path));
    directories.set(directory, files);
    while (directory) {
      directory = posix(relative(root, dirname(resolve(root, directory))));
      if (!directories.has(directory)) directories.set(directory, []);
    }
  }
  const pageParents = new Map<string, string | undefined>();
  const layoutParents = new Map<string, string | undefined>();
  const nodes: RouteNode[] = [...directories.keys()]
    .toSorted()
    .map((directory) => {
      const id = idFor(directory);
      const files = directories.get(directory)!;
      const node: RouteNode = {
        id,
        directory,
        parentId: directory
          ? idFor(posix(relative(root, dirname(resolve(root, directory)))))
          : null,
        layoutParentId: null,
        params: parseRoute(id, resolve(root, files[0] ?? directory)).params,
      };
      for (const parameter of node.params)
        if (parameter.matcher) referencedMatchers.add(parameter.matcher);
      const assigned = new Map<string, string>();
      for (const file of files) {
        const { role, kind, namedParent } = routeFileRole(
          basename(file),
          resolve(root, file),
        );
        const key = `${role}:${kind}`;
        if (assigned.has(key))
          throw new Error(
            `${resolve(root, file)}: duplicate ${role} ${kind}; already defined by ${resolve(root, assigned.get(key)!)}`,
          );
        assigned.set(key, file);
        if (role === "page" && namedParent !== undefined)
          pageParents.set(id, namedParent);
        if (role === "layout" && namedParent !== undefined)
          layoutParents.set(id, namedParent);
        if (role === "endpoint" || role === "error") node[role] = file;
        else (node[role] ??= {})[kind] = file;
      }
      return node;
    });
  if (referencedMatchers.size) {
    if (
      !matcherModule ||
      !requestedMatcherModule ||
      !isAbsolute(requestedMatcherModule)
    ) {
      const node = nodes.find((candidate) =>
        candidate.params.some((parameter) => parameter.matcher),
      )!;
      throw new RouteDiagnostic(
        resolve(root, directories.get(node.directory)![0]),
        node.id,
        segmentOf(node),
        node.id === "/" ? 0 : node.id.split("/").length - 2,
        "Matcher module must be an absolute path when routes reference matchers",
      );
    }
    using graph = new Bun.ModuleGraph();
    let imported: { params?: unknown };
    try {
      imported = await graph.import<{ params?: unknown }>(matcherModule);
    } catch (error) {
      throw new Error(`Unable to load matcher module ${matcherModule}`, {
        cause: error,
      });
    }
    const { params } = imported;
    if (
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      Object.getPrototypeOf(params) !== Object.prototype ||
      Object.values(params).some((matcher) => typeof matcher !== "function")
    )
      throw new Error(
        `${matcherModule}: named export params must be a plain object of functions`,
      );
    const matcherNames = new Set(Object.keys(params));
    activeMatcherModule = matcherModule;
    for (const node of nodes)
      for (const parameter of node.params)
        if (parameter.matcher && !matcherNames.has(parameter.matcher))
          throw new RouteDiagnostic(
            resolve(root, directories.get(node.directory)![0]),
            node.id,
            segmentOf(node),
            node.id === "/" ? 0 : node.id.split("/").length - 2,
            `Parameter matcher ${JSON.stringify(parameter.matcher)} is not exported by ${matcherModule}`,
          );
  }
  const indexes = new Map(nodes.map((node, index) => [node.id, index]));
  const chainFor = (node: RouteNode) => {
    const chain: RouteNode[] = [];
    for (let current: RouteNode | undefined = node; current;) {
      chain.unshift(current);
      current =
        current.parentId === null
          ? undefined
          : nodes[indexes.get(current.parentId)!];
    }
    return chain;
  };
  for (const node of nodes) {
    if (!node.layout) continue;
    const chain = chainFor(node);
    const target = layoutParents.get(node.id);
    let parent: string | null = null;
    let matched = target === undefined;
    for (let index = chain.length - 2; index >= 0; index--) {
      const candidate = chain[index];
      if (!matched) {
        if (segmentOf(candidate) !== target) continue;
        matched = true;
      }
      if (candidate.layout) {
        parent = candidate.id;
        break;
      }
    }
    if (target !== undefined && !matched) {
      const source =
        node.layout.component ??
        node.layout.universal ??
        node.layout.server ??
        node.id;
      throw new RouteDiagnostic(
        resolve(root, source),
        node.id,
        target || "/",
        chain.length - 1,
        `Named layout target ${JSON.stringify(target)} does not exist`,
      );
    }
    node.layoutParentId = parent;
  }
  const routes: RouteEntry[] = [];
  for (const [index, node] of nodes.entries()) {
    if (!node.page && !node.endpoint) continue;
    const chain = chainFor(node);
    const target = pageParents.get(node.id);
    const ancestors: number[] = [];
    const layouts: Array<number | null> = [];
    const errors: Array<number | null> = [];
    let pendingTarget = target;
    for (let cursor = chain.length - 1; cursor >= 0; cursor--) {
      const current = chain[cursor];
      if (pendingTarget !== undefined && segmentOf(current) !== pendingTarget)
        continue;
      const currentIndex = indexes.get(current.id)!;
      ancestors.unshift(currentIndex);
      layouts.unshift(current.layout ? currentIndex : null);
      errors.unshift(current.error ? currentIndex : null);
      pendingTarget = current.layout
        ? layoutParents.get(current.id)
        : undefined;
    }
    if (pendingTarget !== undefined) {
      const source =
        node.page?.component ??
        node.page?.universal ??
        node.page?.server ??
        node.id;
      throw new RouteDiagnostic(
        resolve(root, source),
        node.id,
        pendingTarget || "/",
        chain.length - 1,
        `Named layout target ${JSON.stringify(pendingTarget)} does not exist`,
      );
    }
    routes.push({
      id: node.id,
      ...parseRoute(node.id),
      node: index,
      leaf: node.page ? index : undefined,
      endpoint: node.endpoint,
      ancestors,
      layouts,
      errors,
    });
  }
  try {
    rejectConflicts(routes);
  } catch (error) {
    if (!(error instanceof RouteConflict)) throw error;
    const first = nodes[indexes.get(error.first)!];
    const second = nodes[indexes.get(error.second)!];
    const firstSource = resolve(root, directories.get(first.directory)![0]);
    const secondSource = resolve(root, directories.get(second.directory)![0]);
    const segments = second.directory.split("/");
    throw new RouteDiagnostic(
      secondSource,
      second.id,
      segments.at(-1) || "/",
      segments.length - 1,
      `Route conflict with ${firstSource} (route ${first.id})`,
    );
  }
  return {
    version: 1,
    routesDirectory: root,
    matcherModule: activeMatcherModule,
    nodes,
    routes: sortRoutes(routes),
  };
}

/** Whitelist public metadata; server module paths and the absolute source root never enter this projection. */
export function createClientManifest(
  manifest: RouteManifest,
): ClientRouteManifest {
  return {
    version: manifest.version,
    nodes: manifest.nodes.map((node) => ({
      id: node.id,
      directory: node.directory,
      parentId: node.parentId,
      params: node.params,
      page: node.page
        ? { component: node.page.component, universal: node.page.universal }
        : undefined,
      layout: node.layout
        ? { component: node.layout.component, universal: node.layout.universal }
        : undefined,
      error: node.error,
    })),
    routes: manifest.routes.map(({ endpoint, ...route }) => ({
      ...route,
      endpoint: endpoint ? true : undefined,
    })),
  };
}

/** Use native dispatch for compatible paths; shared matching reconciles overlaps with optional/rest routes. */
export function createRouteDispatcher(
  manifest: RouteManifest,
  callback: (
    request: Request,
    match: RouteMatch,
  ) => Response | Promise<Response>,
  matchers: RouteMatchers = {},
) {
  const dispatch = (request: Request) => {
    let match: RouteMatch | undefined;
    try {
      match = matchRoute(manifest, new URL(request.url).pathname, matchers);
    } catch (error) {
      if (error instanceof URIError)
        return new Response("Malformed URL", { status: 400 });
      throw error;
    }
    return match
      ? callback(request, match)
      : new Response("Not Found", { status: 404 });
  };
  const routes: Record<string, typeof dispatch> = {};
  for (const route of manifest.routes) {
    const segments = urlSegments(route.id);
    if (
      segments.some(
        (segment) =>
          !/^[\w.~-]+$/.test(segment) && !/^\[[A-Za-z_]\w*\]$/.test(segment),
      )
    )
      continue;
    const path =
      "/" +
      segments
        .map((segment) => segment.replace(/^\[([\w-]+)\]$/, ":$1"))
        .join("/");
    routes[path] = dispatch;
  }
  return { routes, fetch: dispatch };
}
