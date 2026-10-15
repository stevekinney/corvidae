/**
 * Pure helpers behind the Playground's "Search components" palette.
 *
 * The palette lists the sidebar's own inventory (`sidebarComponents`), so it
 * never keeps a second list of components. Ranking and the navigation seam
 * live here, away from Svelte, so each is testable from `bun:test` without
 * compiling a component. The shortcut lives in `component-search-shortcut.ts`,
 * which the landing entry bundles on its own.
 */

import { humanizeComponentName } from './humanize.ts';
import { readInstalledNavigation, type ProgressiveNavigation } from './progressive-navigation.ts';
import { buildComponentHref } from './routing.ts';

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

/**
 * The single navigation seam for a selected result. It goes through the page's progressive
 * navigation, which swaps the prerendered document in place and falls back to a native
 * navigation itself on any failure. Where no progressive navigation is installed (a page whose
 * script has not run, or a frame that opts out) it is a real document navigation to the
 * canonical URL.
 */
export function navigateToComponent(
  href: string,
  location: Location = window.location,
  navigation: ProgressiveNavigation | null = readInstalledNavigation(),
): void {
  if (navigation === null) {
    location.assign(href);
    return;
  }
  void navigation.navigate(href);
}
