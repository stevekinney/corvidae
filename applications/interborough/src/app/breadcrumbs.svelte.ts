/**
 * The top bar's breadcrumb trail (design row 06a), derived from the route table: each leading
 * part of the address that a route matches contributes that route's `crumb`, so `/agents/abc/memory`
 * reads Agents › abc › Memory. A crumb that names a path parameter shows the parameter until the
 * page on screen supplies a better label, such as the agent's name, with {@link usePageLabel}.
 */
import type { BreadcrumbItem } from '@lostgradient/cinder';
import { SvelteMap } from 'svelte/reactivity';

import { matchRoute } from '../lib/router.svelte.ts';
import { routes, type RouteDefinition } from './routes.ts';

/** The labels pages supply, by the path they label. */
const pageLabels = new SvelteMap<string, string>();

/**
 * The trail for `pathname`: one item for each leading part of the path whose first matching route
 * has a crumb, each linking to its own path except the last, which is the page itself.
 */
export function breadcrumbTrail(
  pathname: string,
  labels: ReadonlyMap<string, string> = pageLabels,
  table: readonly RouteDefinition[] = routes,
): BreadcrumbItem[] {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const items: { label: string; path: string }[] = [];
  for (let length = 1; length <= segments.length; length += 1) {
    const path = `/${segments.slice(0, length).join('/')}`;
    const match = matchRoute(path, table);
    const crumb = table.find((route) => route.pattern === match?.pattern)?.crumb;
    if (match === null || crumb === undefined) continue;
    const label =
      labels.get(path) ??
      (typeof crumb === 'string'
        ? crumb
        : Object.hasOwn(match.params, crumb.param)
          ? match.params[crumb.param]
          : undefined);
    if (label !== undefined) items.push({ label, path });
  }
  return items.map((item, index) =>
    index === items.length - 1 ? { label: item.label } : { label: item.label, href: item.path },
  );
}

/**
 * Supplies the breadcrumb label for `path` while the calling component is mounted, such as an
 * agent's name for `/agents/:id`. The getter is read reactively, so a name that loads later
 * replaces the parameter when it arrives; `undefined` leaves the parameter in place.
 */
export function usePageLabel(read: () => { path: string; label: string | undefined }): void {
  $effect(() => {
    const { path, label } = read();
    if (label === undefined) return undefined;
    pageLabels.set(path, label);
    return () => {
      if (pageLabels.get(path) === label) pageLabels.delete(path);
    };
  });
}
