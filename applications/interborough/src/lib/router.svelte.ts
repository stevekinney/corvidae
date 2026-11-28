/** Interborough route metadata and application actions over Velveteen navigation. */
import { routes, type RouteDefinition } from '../app/routes.ts';
import { identifierPath } from './identifier-paths.ts';
import { bindNativeRouteState } from './native-route-state.svelte.ts';

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

  // A final `*` matches one or more segments, captured joined by `/` as `params['*']`, so a plugin's
  // page can sit at a path of several segments (`/plugins/<plugin>/reviews/queue`).
  const wildcard = patternSegments.at(-1) === '*';
  const fixed = wildcard ? patternSegments.slice(0, -1) : patternSegments;
  if (wildcard ? pathSegments.length <= fixed.length : pathSegments.length !== fixed.length) {
    return null;
  }

  const params: Record<string, string> = {};
  if (wildcard) {
    const rest: string[] = [];
    for (const segment of pathSegments.slice(fixed.length)) {
      const decoded = decodeSegment(segment);
      if (decoded === null) return null;
      rest.push(decoded);
    }
    params['*'] = rest.join('/');
  }
  for (const [index, patternSegment] of fixed.entries()) {
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

/** The anchor of a failed run's explanation on its page: the section's `id` and the fragment that opens it. */
export const FAILURE_EXPLANATION_ANCHOR = 'failure-explanation';

/**
 * A failed run's page at its explanation of the failure (COR-2533): the same page as
 * {@link workflowDetailPath}, at the section that says why it failed. A link to the failure in Chat
 * and elsewhere uses this one address.
 */
export function failureExplanationPath(runId: string): string {
  return `${workflowDetailPath(runId)}#${FAILURE_EXPLANATION_ANCHOR}`;
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

type NativeNavigationState = Parameters<typeof bindNativeRouteState>[0];

class ApplicationRouter {
  #native: ReturnType<typeof bindNativeRouteState> | undefined;
  #leaveGuards: ((destination: string) => boolean)[] = [];

  /** Attach Velveteen to the installed document before its descendants read the route. */
  bindNative(state: NativeNavigationState): () => void {
    if (this.#native !== undefined) throw new Error('A document router is already mounted');
    const native = bindNativeRouteState(state, (path) =>
      this.#leaveGuards.toReversed().every((guard) => guard(path)),
    );
    this.#native = native;
    return () => {
      native.dispose();
      if (this.#native === native) this.#native = undefined;
    };
  }

  get #navigation() {
    if (this.#native === undefined) throw new Error('No Velveteen document navigation is mounted');
    return this.#native;
  }

  guardLeaving(guard: (destination: string) => boolean): () => void {
    this.#leaveGuards.push(guard);
    return () => {
      this.#leaveGuards = this.#leaveGuards.filter((candidate) => candidate !== guard);
    };
  }

  get hash(): string {
    return this.#navigation.url.hash;
  }

  get pathname(): string {
    return this.#navigation.url.pathname;
  }

  get search(): URLSearchParams {
    return this.#navigation.url.searchParams;
  }

  get viewKey(): string {
    return this.#navigation.viewKey;
  }

  get match(): RouteMatch | null {
    return this.#navigation.match;
  }

  get current(): RouteState {
    return this.#navigation.current;
  }

  navigate(
    path: string,
    options?: { readonly replace?: boolean; readonly keep?: boolean; readonly force?: boolean },
  ): void {
    void this.#navigation.navigate(path, options);
  }

  href(path: string): string {
    return path;
  }
}

export const router = new ApplicationRouter();

/**
 * The question a form asks before its page is left with work the person has not saved: one
 * primitive every form reuses (the agent editor, and a Settings tab with unsaved changes). It
 * registers with {@link ApplicationRouter.guardLeaving}, so Cancel, the breadcrumb, a link in the
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
