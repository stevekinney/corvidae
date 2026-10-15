/**
 * Decides whether a click on a link may be turned into an in-page navigation.
 *
 * Every link on the site stays a plain `<a href>`, so a visit that does not qualify here (a
 * modified click, a link to another origin, a download, a `target`, or a script that never ran)
 * is a native navigation to a complete prerendered document. The policy is deliberately narrow:
 * it accepts only the two canonical document shapes the static export writes, `/` and
 * `/page/<name>`, and nothing with a query string.
 */

import { parseComponentFromPath } from './routing.ts';

/** The parts of a mouse event the policy reads. */
export type NavigationClick = {
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** The parts of an anchor the policy reads. */
export type NavigationAnchor = {
  /** The resolved absolute URL (`HTMLAnchorElement.href`). */
  href: string;
  target: string;
  hasDownload: boolean;
  rel: string;
};

/** True for `/` and for a canonical `/page/<name>` pathname. */
export function isCanonicalDocumentPath(pathname: string): boolean {
  return (
    pathname === '/' || (pathname.startsWith('/page/') && parseComponentFromPath(pathname) !== null)
  );
}

/**
 * The URL to navigate to for `href` when the playground can swap to it in place, or `null` when
 * the browser should navigate natively. `href` may be relative; `currentUrl` is the document's
 * address. A link to the current path is native, because that is either a hash jump the browser
 * already performs or a deliberate reload.
 */
export function resolveInPageNavigation(href: string, currentUrl: URL): URL | null {
  let target: URL;
  try {
    target = new URL(href, currentUrl);
  } catch {
    return null;
  }
  if (target.origin !== currentUrl.origin) return null;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  if (target.search !== '') return null;
  if (!isCanonicalDocumentPath(target.pathname)) return null;
  if (target.pathname === currentUrl.pathname) return null;
  return target;
}

/**
 * The URL to navigate to for a click, or `null` when the click must stay native: anything but a
 * plain primary-button click, a click another handler already claimed, and any anchor that is a
 * download, names a `target` other than the current frame, or is marked external.
 */
export function resolveClickNavigation(
  click: NavigationClick,
  anchor: NavigationAnchor,
  currentUrl: URL,
): URL | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (anchor.hasDownload) return null;
  if (anchor.target !== '' && anchor.target !== '_self') return null;
  if (anchor.rel.split(/\s+/).includes('external')) return null;
  return resolveInPageNavigation(anchor.href, currentUrl);
}
