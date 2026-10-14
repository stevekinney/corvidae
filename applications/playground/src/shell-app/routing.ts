/**
 * Pure routing helpers for the playground shell SPA.
 *
 * Extracted from the Svelte components so they're testable without a DOM.
 * Every helper is side-effect-free; the SPA is responsible for choosing what
 * to do with the return values (e.g. seeding state, building hrefs).
 */

/**
 * Regex that matches the component-name invariant enforced server-side by
 * `isSafeSegment` in `server.ts`. Kebab-case, ASCII only, starts with
 * alphanumeric. Kept in sync with `/^[a-z0-9][a-z0-9-]*$/` at server.ts:523.
 */
const COMPONENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Extract a component name from a `/page/:name` pathname. Returns `null` for
 * any input that doesn't match the route shape or whose segment fails the
 * kebab-case invariant. The caller decides what to do with `null` — typically
 * leave the current component unchanged.
 *
 * Trailing path segments are rejected (`/page/avatar/extra` returns null) so
 * the helper has the same shape as the server's `/page/:name` route.
 *
 * The legacy `/c/:name` spelling is also accepted, because links to it exist in
 * the wild (and the server 301s them here). Accepting both keeps in-page
 * click interception working if a stale anchor survives anywhere.
 */
export function parseComponentFromPath(pathname: string): string | null {
  const match = /^\/(?:page|c)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!COMPONENT_NAME_PATTERN.test(decoded)) return null;
  return decoded;
}

/**
 * Build the canonical documentation URL for a component — used for sidebar
 * anchor `href` attributes and navigation. The component name is always encoded
 * defensively, even though kebab slugs don't actually need encoding; this keeps
 * URL construction safe if the invariant ever slips.
 *
 * There is exactly ONE documentation page per component and it lives at
 * `/page/<name>`. The former `/c/<name>` shell page was a second, condensed
 * rendering of the same content; it now 301s here.
 */
export function buildComponentHref(componentName: string): string {
  return `/page/${encodeURIComponent(componentName)}`;
}

/**
 * Theme and background value unions are defined here so this pure-helper module has no import from
 * any Svelte file. That keeps it cleanly unit-testable from `bun:test`
 * without paying the `.svelte.ts` compilation cost in test boot.
 */
export type ThemeChoice = 'light' | 'dark';

/**
 * Canonical search-param keys for the toolbar. Compact spellings (`w`) keep
 * shareable URLs readable; full-word keys are reserved for future additions
 * that don't appear together with these.
 */
export const TOOLBAR_PARAMS = {
  focus: 'focus',
  theme: 'theme',
  width: 'w',
} as const;

const FOCUS_MODE_TRUTHY: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** Minimum and maximum viewport widths accepted from the `w` param. */
const VIEWPORT_WIDTH_MIN = 200;
const VIEWPORT_WIDTH_MAX = 3840;

/**
 * Read focus mode from a URLSearchParams instance. Tolerates a few truthy
 * spellings so handwritten URLs work; anything else is false.
 */
export function readFocusModeFromSearch(search: URLSearchParams): boolean {
  const raw = search.get(TOOLBAR_PARAMS.focus);
  if (raw === null) return false;
  return FOCUS_MODE_TRUTHY.has(raw.toLowerCase());
}

/**
 * Read a viewport width from a URLSearchParams instance. Returns `null`
 * (full / unconstrained) for missing, non-numeric, or out-of-range values.
 */
export function readPreviewWidthFromSearch(search: URLSearchParams): number | null {
  const raw = search.get(TOOLBAR_PARAMS.width);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return null;
  if (parsed < VIEWPORT_WIDTH_MIN || parsed > VIEWPORT_WIDTH_MAX) return null;
  return parsed;
}

/**
 * The search string after the reader picks `theme`, rewriting a `theme` parameter
 * that is already on the URL and touching nothing else. The pre-paint script lets
 * the URL win over `localStorage` so a shared `?theme=dark` link paints dark, which
 * means a stale `theme=dark` would undo a later choice of light on the next load.
 * A URL that carries no `theme` parameter stays without one: the choice then lives
 * in `localStorage` only, and the link the reader shares does not start forcing it.
 */
export function searchForTheme(search: URLSearchParams, theme: ThemeChoice): string {
  const next = new URLSearchParams(search);
  if (next.has(TOOLBAR_PARAMS.theme)) next.set(TOOLBAR_PARAMS.theme, theme);
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * The search string after the reader picks a stage width, keeping every other
 * parameter where it was. `null` (the full width) is the default and is expressed
 * by REMOVING the parameter, so the canonical URL stays clean; a width is written
 * even to a URL that had none, because the stage width lives nowhere but the URL
 * and a reload or a shared link must restore what the reader chose, not what they
 * arrived with.
 */
export function searchForPreviewWidth(search: URLSearchParams, width: number | null): string {
  const next = new URLSearchParams(search);
  if (width === null) next.delete(TOOLBAR_PARAMS.width);
  else next.set(TOOLBAR_PARAMS.width, String(width));
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * The search string after focus mode turns on or off, keeping every other
 * parameter where it was. Off is the default and is expressed by REMOVING the
 * parameter; on is written as `focus=1`, which also normalizes a handwritten
 * spelling such as `focus=true`.
 */
export function searchForFocusMode(search: URLSearchParams, focused: boolean): string {
  const next = new URLSearchParams(search);
  if (focused) next.set(TOOLBAR_PARAMS.focus, '1');
  else next.delete(TOOLBAR_PARAMS.focus);
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * The two views a component page can be in.
 *
 * Documentation and Playground are separate views rather than two panes because
 * the preview rail took a fixed 38rem out of every page width, and the prose
 * column starved: the accessibility notes rendered in a half-width sub-column,
 * the keyboard-shortcut table shredded to one word per line, and the props table
 * stacked into six labelled rows per prop. Each view now gets the width it needs.
 */
export type ComponentPageView = 'documentation' | 'playground';

/** The query parameter carrying the active view, so a view is linkable. */
export const VIEW_PARAM = 'view';

/**
 * Read the active view from a URLSearchParams instance. Anything unrecognised
 * falls back to `documentation` — a bad `?view=` should land the reader on the
 * docs, not on an error.
 */
export function readViewFromSearch(search: URLSearchParams): ComponentPageView {
  return search.get(VIEW_PARAM) === 'playground' ? 'playground' : 'documentation';
}

/**
 * The search string for a view, preserving every other parameter already on the
 * URL (focus mode and stage width both live there too). The default view is
 * expressed by REMOVING the parameter rather than spelling it out, so the
 * canonical docs URL stays clean.
 */
export function searchForView(search: URLSearchParams, view: ComponentPageView): string {
  const next = new URLSearchParams(search);
  if (view === 'documentation') next.delete(VIEW_PARAM);
  else next.set(VIEW_PARAM, view);
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}
