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

/** The page that edits a schedule's cadence. A dot-only identifier is carried as `scheduleDetailPath` carries one. */
export function scheduleEditPath(scheduleId: string): string {
  const [path = '', query] = scheduleDetailPath(scheduleId).split('?');
  return `${path}/edit${query === undefined ? '' : `?${query}`}`;
}

/** The page that makes a schedule. */
export function scheduleCreatePath(): string {
  return '/schedules/new';
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
  // Bumped when a navigation lands on the address a kept page was keyed on, so that address is a
  // new page and not the kept one: a kept key is a past address, and a pathname can be reached again.
  #generation = $state(0);
  // What a page registered to be asked before the address changes (`guardLeaving`).
  #leaveGuards: ((destination: string) => boolean)[] = [];
  // The address the page was last at, so a back or forward that a guard refused can be undone.
  #settledAddress: string | undefined;

  /** Subscribes to `popstate` on first use, so evaluating this module never touches `window`. */
  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    window.addEventListener('popstate', () => {
      const arrived = `${window.location.pathname}${window.location.search}`;
      const settled = this.#settledAddress;
      // The browser has already moved, so a refused move goes back to where the page was. The
      // guard that refused it keeps the address it was asked about, to go there if it is let through.
      if (settled !== undefined && settled !== arrived && !this.#allowsLeaving(arrived)) {
        window.history.pushState(null, '', settled);
        return;
      }
      this.#settledAddress = arrived;
      const leftKey = this.#keptKey;
      this.#keptKey = undefined;
      this.#syncFromLocation();
      if (leftKey !== undefined && this.viewKey === leftKey) this.#generation += 1;
    });
  }

  /** Asks every registered guard, newest first, whether the page may be left for `destination`. */
  #allowsLeaving(destination: string): boolean {
    for (const guard of this.#leaveGuards.toReversed()) {
      if (!guard(destination)) return false;
    }
    return true;
  }

  /**
   * Registers a question the router asks before it leaves the current page: `guard` is given the
   * address the navigation is for and answers whether to go. A page that holds work the person has
   * not saved answers `false` and asks them (a dialog), then calls `navigate(destination, { force:
   * true })` if they choose to leave. A back or forward the guard refuses puts the address back.
   * Returns the function that removes the guard, which the page calls when it unmounts.
   */
  guardLeaving(guard: (destination: string) => boolean): () => void {
    this.#listen();
    this.#settledAddress = `${window.location.pathname}${window.location.search}`;
    this.#leaveGuards.push(guard);
    return () => {
      this.#leaveGuards = this.#leaveGuards.filter((candidate) => candidate !== guard);
    };
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
    const key =
      found !== null && params !== found.params
        ? `${this.pathname}#${JSON.stringify(params)}`
        : this.pathname;
    // A raw NUL cannot be in a pathname (it arrives as %00), so this key is no address's.
    return this.#generation === 0 ? key : `${key}\u0000${this.#generation}`;
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
   * names the same thing the page already shows. A page's leave guard (`guardLeaving`) may refuse
   * the navigation; `force` skips the guards.
   */
  navigate(
    path: string,
    options?: { readonly replace?: boolean; readonly keep?: boolean; readonly force?: boolean },
  ): void {
    this.#listen();
    // A page that guards leaving is asked first; `force` is the answer to its own question.
    if (options?.force !== true && !this.#allowsLeaving(path)) return;
    // A kept page carries on under the key it already had; any other navigation ends that.
    const leftKey = this.#keptKey;
    this.#keptKey = options?.keep === true ? this.viewKey : undefined;
    if (options?.replace) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
    this.#syncFromLocation();
    this.#settledAddress = `${window.location.pathname}${window.location.search}`;
    // Arriving at the address the kept page was keyed on is a new page, even though the key it
    // computes is the one that is mounted (a new chat's address, after that chat started).
    if (leftKey !== undefined && this.#keptKey === undefined && this.viewKey === leftKey) {
      this.#generation += 1;
    }
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

/**
 * The question a form asks before its page is left with work the person has not saved: one
 * primitive every form reuses (the agent editor, and a Settings tab with unsaved changes). It
 * registers with {@link DashboardRouter.guardLeaving}, so Cancel, the breadcrumb, a link in the
 * shell, and back or forward are all asked, and with the window's `beforeunload`, so closing the tab
 * or reloading is asked by the browser. A navigation it refuses is kept, and the page's dialog,
 * open while {@link LeaveGuard.asking} is true, answers with {@link LeaveGuard.leave} (go there,
 * discarding the work) or {@link LeaveGuard.stay}. A form with nothing to lose is never asked about.
 *
 * ```ts
 * const guard = new LeaveGuard(() => form.changed);
 * $effect(() => guard.attach());
 * ```
 */
export class LeaveGuard {
  /** A navigation was refused, so the page shows its question until it is answered. */
  asking = $state(false);
  /** Whether the page holds work a navigation would discard, asked at each navigation. */
  readonly #holdsWork: () => boolean;
  /** Where the refused navigation was going. */
  #destination: string | undefined;
  /** Set once the page may go without asking: its work was saved, or the person chose to discard it. */
  #released = false;

  /** `holdsWork` answers whether leaving now would discard something; it is read at each navigation. */
  constructor(holdsWork: () => boolean) {
    this.#holdsWork = holdsWork;
  }

  /** Whether leaving now would be asked about. */
  get guarding(): boolean {
    return !this.#released && this.#holdsWork();
  }

  /**
   * Starts asking: registers the router's guard and the window's `beforeunload`. Returns the
   * function that stops, which an `$effect` that calls this runs when the page unmounts.
   */
  attach(): () => void {
    const stop = router.guardLeaving((destination) => {
      if (!this.guarding) return true;
      this.#destination = destination;
      this.asking = true;
      return false;
    });
    const warn = (event: BeforeUnloadEvent): void => {
      if (this.guarding) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      stop();
      window.removeEventListener('beforeunload', warn);
    };
  }

  /** Lets the page go without asking from now on, such as when a save has landed and it moves on. */
  release(): void {
    this.#released = true;
  }

  /** Where the refused navigation was going, while the page asks; `undefined` otherwise. */
  get destination(): string | undefined {
    return this.#destination;
  }

  /**
   * The person chose to discard their work: goes where the refused navigation was going. With
   * `keep`, the mounted route stays mounted, for a destination that names the same thing the page
   * shows (another tab of the same agent's page, row 39b).
   */
  leave(options?: { readonly keep?: boolean }): void {
    const destination = this.#destination;
    this.#released = true;
    this.asking = false;
    this.#destination = undefined;
    if (destination === undefined) return;
    router.navigate(
      destination,
      options?.keep === true ? { force: true, keep: true } : { force: true },
    );
  }

  /** The person chose to keep editing: the page stays, and the next navigation is asked again. */
  stay(): void {
    this.asking = false;
    this.#destination = undefined;
  }
}
