/**
 * Pure helpers behind the Playground's "Search components" palette.
 *
 * The palette lists the sidebar's own inventory (`sidebarComponents`), so it
 * never keeps a second list of components. Ranking, the shortcut predicate,
 * and the navigation seam live here, away from Svelte, so each is testable from
 * `bun:test` without compiling a component.
 */

import { humanizeComponentName } from './humanize.ts';
import { buildComponentHref } from './routing.ts';

/** Accessible name and visible text of the palette trigger. */
export const COMPONENT_SEARCH_LABEL = 'Search components';

/** Text the palette shows when no component matches the query. */
export const COMPONENT_SEARCH_EMPTY_TEXT = 'No matching components.';

export type ComponentSearchResult = {
  /** The kebab-case component name the sidebar routes by. */
  name: string;
  /** The label the sidebar shows for this component. */
  label: string;
  /** The canonical documentation URL for this component. */
  href: string;
};

const EXACT = 0;
const PREFIX = 1;
const SUBSTRING = 2;

function matchTier(name: string, label: string, query: string): number | undefined {
  if (query === '') return SUBSTRING;
  const lowerLabel = label.toLowerCase();
  if (name === query || lowerLabel === query) return EXACT;
  if (name.startsWith(query) || lowerLabel.startsWith(query)) return PREFIX;
  if (name.includes(query) || lowerLabel.includes(query)) return SUBSTRING;
  return undefined;
}

/**
 * Rank the sidebar inventory against a query: exact label or slug matches
 * first, then prefix matches, then substring matches, each tier in label order.
 * Matching is case-insensitive. An empty query lists every component in label
 * order.
 */
export function rankComponents(
  components: readonly string[],
  query: string,
): ComponentSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  const ranked: Array<ComponentSearchResult & { tier: number }> = [];
  for (const name of new Set(components)) {
    const label = humanizeComponentName(name);
    const tier = matchTier(name, label, normalizedQuery);
    if (tier === undefined) continue;
    ranked.push({ name, label, href: buildComponentHref(name), tier });
  }
  ranked.sort(
    (left, right) =>
      left.tier - right.tier ||
      left.label.localeCompare(right.label, 'en') ||
      left.name.localeCompare(right.name, 'en'),
  );
  return ranked.map(({ name, label, href }) => ({ name, label, href }));
}

function isEditable(element: Element | null): boolean {
  if (element === null) return false;
  if (element.closest('input, textarea, select') !== null) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * True when a keydown should open the palette: Cmd+K or Ctrl+K with no other
 * modifier, not a held-key repeat, not mid IME composition, not while an
 * editable control has focus, and not while any dialog is already open — a
 * demo dialog, or the palette itself.
 */
export function isComponentSearchShortcut(event: KeyboardEvent, document: Document): boolean {
  if (event.defaultPrevented || event.repeat) return false;
  if (event.isComposing || event.key === 'Process') return false;
  if (event.key.toLowerCase() !== 'k') return false;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  if (isEditable(document.activeElement)) return false;
  // A closed `<dialog aria-modal="true">` — the palette's own, kept mounted between
  // opens — is not an open dialog, so only an open `<dialog>` or a non-dialog
  // element declaring itself modal blocks the shortcut.
  return document.querySelector('dialog[open], [aria-modal="true"]:not(dialog)') === null;
}

/**
 * The single navigation seam for a selected result. A real document navigation
 * to the canonical URL — no client-side routing — so a later progressive
 * enhancement has exactly one place to change.
 */
export function navigateToComponent(href: string, location: Location = window.location): void {
  location.assign(href);
}
