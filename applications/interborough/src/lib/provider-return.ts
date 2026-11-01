/**
 * Where Settings › Models sends a person back to after they connect a provider. A page that needs
 * a provider (the agent editor, with no model to offer) links to Models with the path it came from
 * in `?return=`, and Models shows a way back. The address is read from the query string, so it is
 * never followed on trust: only a path of a page that is made to be returned to counts, so a
 * crafted link cannot send a person to another site, or to a page Models was never meant to lead to.
 */
import { matchRoute } from './router.svelte.ts';

/** Settings › Models. */
const MODELS_PATH = '/settings/models';

/** The pages Models returns to: the agent editor, new or existing. */
const RETURNABLE_PATTERNS: ReadonlySet<string> = new Set(['/agents/new', '/agents/:agent/edit']);

/** The address of Models that returns to `path` once a provider is connected. */
export function connectProviderPath(path: string): string {
  return `${MODELS_PATH}?${new URLSearchParams({ return: path }).toString()}`;
}

/**
 * The path `search` asks to return to, or `null` when it asks for none or for a path that is not
 * one of the pages that can be returned to (an absolute address, a path with a query or fragment,
 * a path of another page).
 */
export function returnPathOf(search: URLSearchParams): string | null {
  const path = search.get('return');
  if (path === null || !path.startsWith('/') || path.startsWith('//')) return null;
  if (path.includes('?') || path.includes('#') || path.includes('\\')) return null;
  const match = matchRoute(path);
  return match !== null && RETURNABLE_PATTERNS.has(match.pattern) ? path : null;
}
