export type RouteParameterValue = string | number | bigint | boolean;
export type RouteMatcher = (value: string) => RouteParameterValue | undefined;
export type RouteMatchers = Record<string, RouteMatcher>;

/** Parameters retain route spelling; optional parameters may be absent, rest values may be empty. */
export type RouteParam = {
  name: string;
  matcher?: string;
  optional: boolean;
  rest: boolean;
  /** Optional and rest captures that can shift values into a following capture. */
  chained?: boolean;
};

/** Application source paths are POSIX paths relative to routesDirectory. */
export type RouteModules = {
  component?: string;
  universal?: string;
  server?: string;
};

/** One physical route directory, including groups and layout-only ancestors. */
export type RouteNode = {
  id: string;
  directory: string;
  parentId: string | null;
  /** Effective parent layout; parentId remains the physical directory parent. */
  layoutParentId: string | null;
  params: RouteParam[];
  page?: RouteModules;
  layout?: RouteModules;
  error?: string;
  endpoint?: string;
};

/** One addressable page and/or endpoint. All index arrays refer to the same nodes array. */
export type RouteEntry = {
  id: string;
  pattern: string;
  params: RouteParam[];
  node: number;
  leaf?: number;
  endpoint?: string;
  ancestors: number[];
  /** Parallel to ancestors; null means no application layout at that level. */
  layouts: Array<number | null>;
  /** Parallel to ancestors; null means no application error component at that level. */
  errors: Array<number | null>;
};

/** The sole discovery result consumed by dispatch, browser metadata and type generation. */
export type RouteManifest = {
  version: 1;
  routesDirectory: string;
  /** Server-only absolute source path; omitted from the client projection. */
  matcherModule?: string;
  nodes: RouteNode[];
  routes: RouteEntry[];
};

export type ClientRouteNode = Omit<
  RouteNode,
  "page" | "layout" | "endpoint" | "layoutParentId"
> & {
  page?: Omit<RouteModules, "server">;
  layout?: Omit<RouteModules, "server">;
};
export type ClientRouteEntry = Omit<RouteEntry, "endpoint"> & {
  endpoint?: true;
};
export type ClientRouteManifest = {
  version: 1;
  nodes: ClientRouteNode[];
  routes: ClientRouteEntry[];
};
export type MatchableRoute = Pick<RouteEntry, "id" | "pattern" | "params">;
export type RouteMatch<Route extends MatchableRoute = RouteEntry> = {
  route: Route;
  params: Record<string, RouteParameterValue>;
  pathname: string;
};
