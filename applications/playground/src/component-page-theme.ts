/**
 * Theme, preview-width, and nav-filter adoption for the documentation page.
 *
 * All three settings must render identically on the server and the client's
 * first (pre-hydration) pass, then adopt their real value from the
 * environment (document/`localStorage`/URL/`sessionStorage`) once the client
 * is live — reading any of them during init instead would make the server's
 * markup and the client's hydration render disagree. `component-page.svelte`
 * owns the `$state`/`$effect` wiring that does the seeding and adoption (see
 * its hydration-adoption effect); this module owns the pure reads and the
 * DOM/storage write `toggleTheme` performs, following the same split
 * `component-page-scroll-spy.ts` already uses for a sibling concern.
 */

import {
  readPreviewWidthFromSearch,
  searchForFocusMode,
  searchForPreviewWidth,
  searchForTheme,
  searchForView,
  TOOLBAR_PARAMS,
  type ComponentPageView,
} from './shell-app/routing.ts';
import { THEME_STORAGE_KEY } from './shell-app/theme-storage.ts';

/**
 * Preview stage widths. `null` means "fill the pane". The numeric values match
 * the breakpoints the shell's viewport control used, so shared links keep
 * meaning the same thing.
 */
export const PREVIEW_WIDTHS = [
  { label: 'Mobile', width: 375 },
  { label: 'Tablet', width: 768 },
  { label: 'Desktop', width: 1280 },
  { label: 'Full', width: null },
] as const satisfies readonly { label: string; width: number | null }[];

export const NAV_FILTER_STORAGE_KEY = 'cinder-playground-nav-filter';

/**
 * A chosen theme is written as `color-scheme`, `data-theme` and `data-cinder-theme`.
 * `data-theme` is the switch Cinder's built tokens honor, because Bun lowers
 * their `light-dark()` to toggles keyed on `prefers-color-scheme` and
 * `:root[data-theme]`; `data-cinder-theme` is the playground's own signal.
 * Server rendering has no `document`, so the SSR tree seeds `light` —
 * matching the base `color-scheme: light dark` first argument — and the
 * real preference is adopted in an `$effect` after hydration. Seeding from
 * the document during init would make the server and client first render
 * disagree (a hydration mismatch); deferring the read is the same
 * discipline `shell.svelte` uses for its persisted theme.
 */
export function readInitialTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  const scheme = document.documentElement.style.colorScheme;
  if (scheme === 'dark' || scheme === 'light') return scheme;
  return document.documentElement.dataset['cinderTheme'] === 'dark' ? 'dark' : 'light';
}

/*
 * Seed from the URL so `?w=768&focus=1` still means what it did on the shell —
 * `/c/<name>?w=…` preserves its query across the 301, so those links keep
 * working. Read once, and only in the browser: the server tree must not depend
 * on values the client would then re-derive.
 */
export function readInitialPreviewWidth(): number | null {
  if (typeof window === 'undefined') return null;
  return readPreviewWidthFromSearch(new URLSearchParams(window.location.search));
}

/*
 * Persisted across navigation. Selecting a component is a full document load,
 * so without this a filtered list resets the moment you use it.
 */
export function readStoredNavFilter(): string {
  if (typeof sessionStorage === 'undefined') return '';
  try {
    return sessionStorage.getItem(NAV_FILTER_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Replace the address bar's query with the one `rewrite` derives from it, leaving
 * the path, the hash, and the history state alone. `rewrite` returns `null` to
 * leave the URL untouched. `replaceState`, not `pushState`, so Back does not have
 * to walk through a control change.
 */
function rewriteAddressBarSearch(rewrite: (search: URLSearchParams) => string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    const search = rewrite(url.searchParams);
    if (search === null) return;
    window.history.replaceState(window.history.state, '', `${url.pathname}${search}${url.hash}`);
  } catch {
    // A sandboxed frame can refuse to rewrite its URL — the control still applies.
  }
}

/**
 * Rewrite an existing `?theme=` on the address bar to the theme just chosen. The
 * pre-paint script prefers the URL over `localStorage`, so leaving `theme=dark`
 * behind after a toggle to light would repaint dark on the next reload. A URL with
 * no `theme` parameter is left untouched.
 */
function synchronizeThemeQuery(theme: 'light' | 'dark'): void {
  rewriteAddressBarSearch((search) =>
    search.has(TOOLBAR_PARAMS.theme) ? searchForTheme(search, theme) : null,
  );
}

/**
 * Keep `?w=` in step with the stage width the reader chose. The width is seeded
 * from the URL (see {@link readInitialPreviewWidth}) and persisted nowhere else, so
 * a control that changed only in-memory state left the old `w` behind and a reload
 * or a shared link restored the stale width instead of the selection.
 */
export function synchronizePreviewWidthQuery(width: number | null): void {
  rewriteAddressBarSearch((search) => searchForPreviewWidth(search, width));
}

/**
 * Keep `?view=` in step with the view the reader switched to. The fragment and the history state
 * stay where they were, so switching to the Playground and back leaves the reader's anchor in the
 * URL they reload or share.
 */
export function synchronizeViewQuery(view: ComponentPageView): void {
  rewriteAddressBarSearch((search) => searchForView(search, view));
}

/** Keep `?focus=` in step with focus mode, for the same reason as {@link synchronizePreviewWidthQuery}. */
export function synchronizeFocusModeQuery(focused: boolean): void {
  rewriteAddressBarSearch((search) => searchForFocusMode(search, focused));
}

/**
 * Write the resolved theme to the DOM, persist it to `localStorage`, and keep an
 * existing `?theme=` in step with it. Used by `toggleTheme` — never assign the
 * theme's DOM/storage targets directly.
 */
export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.style.colorScheme = theme;
  // Cinder's built tokens switch on `data-theme`, not `color-scheme`.
  document.documentElement.dataset['theme'] = theme;
  document.documentElement.dataset['cinderTheme'] = theme;
  try {
    // Same key the pre-paint script in render-shell.ts reads. It previously
    // wrote `cinder-docs-theme`, which nothing read, so the choice was lost on
    // every navigation.
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode / disabled storage — the in-memory theme still applies.
  }
  synchronizeThemeQuery(theme);
}

/**
 * Follow the operating system's color scheme while the reader has chosen no theme.
 *
 * With no override, the base `color-scheme: light dark` makes the page colors follow the system
 * live, but the pre-paint script sampled `prefers-color-scheme` once, so `data-cinder-theme`, the
 * toggle's label and icon, and the stores keyed by theme kept the theme the page loaded with.
 * This keeps `data-cinder-theme` current and reports each change so the caller can update the rest.
 *
 * A concrete `color-scheme` on the root (set from the URL, from storage, or by the toggle) is a
 * choice, and it wins: the system is ignored from then on. Returns the function that stops following.
 */
export function followSystemTheme(onChange: (theme: 'light' | 'dark') => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = (event: { matches: boolean }): void => {
    const scheme = document.documentElement.style.colorScheme;
    if (scheme === 'dark' || scheme === 'light') return;
    const theme = event.matches ? 'dark' : 'light';
    document.documentElement.dataset['cinderTheme'] = theme;
    onChange(theme);
  };
  query.addEventListener('change', onSystemChange);
  return () => query.removeEventListener('change', onSystemChange);
}
