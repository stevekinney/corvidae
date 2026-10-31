/**
 * History-API router (plan §4, §8, T1.3). Frozen after the Phase 1
 * Foundation gate — see PROJECT-BRIEF "Shared contracts". Parses the current
 * location against the route table in `src/app/routes.ts` into a
 * rune-backed `{ route, params, search }` triple (`router.current`);
 * `navigate()`/`back()`/`forward()`/`href()` are the only way surfaces
 * should touch `window.history`, so the whole app agrees on one history-API
 * story with no SvelteKit involved.
 *
 * `window` is read lazily, on the router's first use, never at module
 * evaluation: the router is a module-scope singleton, and a server render
 * or a Node consumer that imports the entry without a DOM must not throw just
 * because this module was evaluated.
 */
import { routes, type RouteDefinition } from '../app/routes.ts';
import { identifierPath, withEscapedIdentifier } from './identifier-paths.ts';

/** A route pattern a location matched and the parameters it captured. */
export interface RouteMatch {
  readonly pattern: string;
  readonly params: Readonly<Record<string, string>>;
}

/** The router's fully parsed view of the current location (plan §4, §8). */
export interface RouteState {
  /** The matched route definition, or `null` when no owned pattern matches. */
  readonly route: RouteDefinition | null;
  /** Named path params extracted from `route.pattern`, e.g. `{ run: 'wf_123' }`. */
  readonly params: Readonly<Record<string, string>>;
  /** The current location's query string. */
  readonly search: URLSearchParams;
}

/** A path segment decoded, or `null` when it is not valid percent-encoding (`%E0`). */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = pathname.split('/').filter((segment) => segment.length > 0);

  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (const [index, patternSegment] of patternSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return null;

    if (patternSegment.startsWith(':')) {
      // An address that cannot be decoded names no resource, so no route owns it: the outlet
      // shows the not-found view instead of the matcher throwing out of the router.
      const decoded = decodeSegment(pathSegment);
      if (decoded === null) return null;
      params[patternSegment.slice(1)] = decoded;
      continue;
    }

    if (patternSegment !== pathSegment) return null;
  }

  return params;
}

/**
 * Builds a workflow detail path. Dot-only identifiers use a query-carried
 * escape because browsers normalize those exact path segments before the
 * client router can read them; every other identifier retains its legacy URL.
 */
export function workflowDetailPath(
  workflowId: string,
  search: URLSearchParams = new URLSearchParams(),
): string {
  return identifierPath('runs', '/runs/:run', workflowId, search);
}

/**
 * A run's page under the workflow it belongs to, for a caller that knows the workflow type. It is
 * the same page as {@link workflowDetailPath}, and neither redirects to the other.
 */
export function workflowRunPath(
  workflowType: string,
  runId: string,
  search: URLSearchParams = new URLSearchParams(),
): string {
  return identifierPath(
    `workflows/${encodeURIComponent(workflowType)}/runs`,
    '/workflows/:workflow/runs/:run',
    runId,
    search,
  );
}

/** A schedule's page. A dot-only identifier is carried as `workflowDetailPath` carries one. */
export function scheduleDetailPath(
  scheduleId: string,
  search: URLSearchParams = new URLSearchParams(),
): string {
  return identifierPath('schedules', '/schedules/:schedule', scheduleId, search);
}

/** A schedule's page with its edit drawer open. */
export function scheduleEditPath(scheduleId: string): string {
  return scheduleDetailPath(scheduleId, new URLSearchParams({ edit: '1' }));
}

/** The schedules list with the create drawer open. */
export function scheduleCreatePath(): string {
  return '/schedules?create=1';
}

interface RouteDefinitionMatch {
  readonly definition: RouteDefinition;
  readonly params: Record<string, string>;
}

/** Finds the first route definition (with its extracted params) matching `pathname`. */
function findRouteDefinition(
  pathname: string,
  definitions: readonly RouteDefinition[],
): RouteDefinitionMatch | null {
  for (const definition of definitions) {
    const params = matchPattern(definition.pattern, pathname);
    if (params) return { definition, params };
  }

  return null;
}

/** Finds the first route definition whose pattern matches `pathname`. */
export function matchRoute(
  pathname: string,
  definitions: readonly RouteDefinition[] = routes,
): RouteMatch | null {
  const found = findRouteDefinition(pathname, definitions);
  return found ? { pattern: found.definition.pattern, params: found.params } : null;
}

/**
 * The type of {@link router}. Not exported by name: it is public only as the
 * structure `router` exposes.
 */
class DashboardRouter {
  // `undefined` until the router itself observes a location change
  // (`navigate()` or a `popstate`). Until then the getters read
  // `window.location` directly, so a first read never writes reactive state:
  // a write from inside a template or `$derived` read is an unsafe mutation
  // in Svelte 5.
  #pathname = $state<string | undefined>(undefined);
  #searchString = $state<string | undefined>(undefined);
  #listening = false;
  // The key the outlet mounts the route under, while a navigation asked the page to keep it
  // (`navigate`'s `keep`). `undefined` means the key is the pathname.
  #keptKey = $state<string | undefined>(undefined);

  /** Subscribes to `popstate` on first use, so evaluating this module never touches `window`. */
  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    window.addEventListener('popstate', () => {
      this.#keptKey = undefined;
      this.#syncFromLocation();
    });
  }

  #syncFromLocation(): void {
    this.#pathname = window.location.pathname;
    this.#searchString = window.location.search;
  }

  /** The current location's pathname, live. */
  get pathname(): string {
    this.#listen();
    return this.#pathname ?? window.location.pathname;
  }

  /** The current location's query string, live (not a frozen snapshot). */
  get search(): URLSearchParams {
    this.#listen();
    return new URLSearchParams(this.#searchString ?? window.location.search);
  }

  /**
   * What the route outlet keys the mounted route on: the pathname (and the identifier an escaped
   * path stands in for), so a new path is a new page.
   * A navigation that asks to `keep` the page leaves the key as it was, so the route that made it
   * stays mounted under the new address (a new chat becoming its session, mid-run).
   */
  get viewKey(): string {
    this.#listen();
    if (this.#keptKey !== undefined) return this.#keptKey;
    // Two identifiers a path stands in for with one placeholder are two pages, not one.
    const found = findRouteDefinition(this.pathname, routes);
    const params = found === null ? undefined : withEscapedIdentifier(found, this.search);
    return found !== null && params !== found.params
      ? `${this.pathname}#${JSON.stringify(params)}`
      : this.pathname;
  }

  /** The route matching the current `pathname`, or `null` for an unowned path. */
  get match(): RouteMatch | null {
    return matchRoute(this.pathname);
  }

  /** The fully parsed `{ route, params, search }` view of the current location. */
  get current(): RouteState {
    const found = findRouteDefinition(this.pathname, routes);
    const search = this.search;
    const params = found === null ? {} : withEscapedIdentifier(found, search);
    return {
      route: found?.definition ?? null,
      params,
      search,
    };
  }

  /**
   * Pushes `path` onto browser history (or replaces the current entry with
   * `options.replace`) and updates the reactive route state. `path` may
   * include a query string (e.g. `/runs?status=running`) — the browser
   * resolves it, so `pathname`/`search` are read back from
   * `window.location` rather than re-parsed here. With `keep`, the page that is mounted stays
   * mounted (see {@link DashboardRouter.viewKey}); use it only with `replace`, for an address that
   * names the same thing the page already shows.
   */
  navigate(path: string, options?: { readonly replace?: boolean; readonly keep?: boolean }): void {
    this.#listen();
    // A kept page carries on under the key it already had; any other navigation ends that.
    this.#keptKey = options?.keep === true ? this.viewKey : undefined;
    if (options?.replace) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
    this.#syncFromLocation();
  }

  /** Goes back one entry in browser history (mirrors the browser's back button). */
  back(): void {
    this.#listen();
    window.history.back();
  }

  /** Goes forward one entry in browser history (mirrors the browser's forward button). */
  forward(): void {
    this.#listen();
    window.history.forward();
  }

  /** Resolves an `href` for a link. Identity today; a seam for a future base path. */
  href(path: string): string {
    return path;
  }
}

/**
 * The dashboard's one router: it parses the browser location, navigates with the History API, and
 * exposes the current route reactively.
 */
export const router = new DashboardRouter();
