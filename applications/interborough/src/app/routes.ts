import type { Component } from 'svelte';

import type { ViewName } from './views.ts';

/**
 * The route registry: a path pattern, the view it renders, and a lazy import of the component
 * that renders it. `:id`-style segments are simple named params; the router
 * (`src/lib/router.svelte.ts`) owns matching semantics, and the first matching pattern wins.
 *
 * The host serves `index.html` for exactly these patterns (`src/host/host.ts`), so a route added
 * here is served there with no second list to edit.
 */
export interface RouteDefinition {
  /** Path pattern, e.g. `/runs/:id`. */
  pattern: string;
  /** The view this route renders. The outlet wraps the route in that view's frame. */
  view?: ViewName;
  /** Lazily imports the route's default-exported Svelte component. */
  load: () => Promise<{ default: Component }>;
}

const placeholder = () => import('../routes/placeholder/index.svelte');

export const routes: readonly RouteDefinition[] = [
  // Chat is the home screen. Sessions live under `/chat/:sessionId`.
  { pattern: '/', view: 'chat', load: placeholder },
  { pattern: '/chat', view: 'chat', load: placeholder },
  {
    pattern: '/chat/:sessionId',
    view: 'chat',
    load: () => import('../routes/chat/index.svelte'),
  },
  { pattern: '/agents', view: 'agents', load: placeholder },
  // `/workflows` is the catalog of workflow definitions. A run of one lives under `/runs`.
  { pattern: '/workflows', view: 'workflows', load: placeholder },
  { pattern: '/workflows/:type', view: 'workflows', load: placeholder },
  { pattern: '/runs', view: 'runs', load: () => import('../routes/workflows/index.svelte') },
  { pattern: '/runs/:id', view: 'runs', load: () => import('../routes/workflows/index.svelte') },
  {
    pattern: '/schedules',
    view: 'schedules',
    load: () => import('../routes/schedules/index.svelte'),
  },
  { pattern: '/inbox', view: 'inbox', load: () => import('../routes/reviews/index.svelte') },
  { pattern: '/workers', view: 'workers', load: () => import('../routes/workers/index.svelte') },
  { pattern: '/storage', view: 'storage', load: () => import('../routes/storage/index.svelte') },
  { pattern: '/system', view: 'system', load: () => import('../routes/system/index.svelte') },
  { pattern: '/audit', view: 'audit', load: placeholder },
  { pattern: '/engine', view: 'engine', load: () => import('../routes/dashboard/index.svelte') },
];
