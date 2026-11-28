import { getContext, hasContext, setContext } from 'svelte';
import { routes } from '../app/routes.ts';
import { matchRoute, router } from './router.svelte.ts';

type Navigation = Pick<typeof router, 'pathname' | 'search' | 'current' | 'href' | 'navigate'>;
const key = Symbol('reviews-navigation');

/** Resolve a navigation target only when it remains on this document's HTTP origin. */
function resolveReviewsDestination(path: string, address: string): URL {
  const current = new URL(address);
  const target = new URL(path, current);
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== current.origin)
    throw new TypeError('Navigation must stay on the application origin');
  return target;
}

/** Supply request-local shell navigation to a native document. */
export function provideReviewsNavigation(address: string): void {
  const url = new URL(address);
  const match = matchRoute(url.pathname);
  const definition = routes.find((route) => route.pattern === match?.pattern) ?? null;
  const navigation: Navigation = {
    get pathname() {
      return typeof window === 'undefined' ? url.pathname : router.pathname;
    },
    get search() {
      return typeof window === 'undefined' ? url.searchParams : router.search;
    },
    get current() {
      return typeof window === 'undefined'
        ? { route: definition, params: match?.params ?? {}, search: url.searchParams }
        : router.current;
    },
    href: (path) => path,
    navigate: (path, options) => {
      const target = resolveReviewsDestination(path, window.location.href);
      if (url.pathname === '/reviews' && target.pathname === '/reviews') {
        router.navigate(path, { ...options, keep: true });
      } else {
        window.location.assign(target.href);
      }
    },
  };
  setContext(key, navigation);
}

/** Use the document-local navigation if present, otherwise the application navigation. */
export function reviewsNavigation(): Navigation {
  return hasContext(key) ? getContext<Navigation>(key) : router;
}
