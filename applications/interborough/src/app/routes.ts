import type { Component } from 'svelte';

import { chatHomePath } from '../routes/chat/chat-home.ts';
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
  /**
   * Where the route goes instead of rendering, decided when it is opened. The outlet replaces the
   * history entry with the path this resolves, so Back does not return to the redirecting address.
   */
  redirect?: () => Promise<string>;
}

const placeholder = () => import('../routes/placeholder/index.svelte');
const agentEditor = () => import('../routes/agent-editor/index.svelte');
const workflowArea = () => import('../routes/workflow-definitions/index.svelte');
const schedulesArea = () => import('../routes/schedules/index.svelte');

export const routes: readonly RouteDefinition[] = [
  // Chat is the home screen. Sessions live under `/chat/:sessionId`.
  // `/` opens the most recently updated session, or `/chat` when there is none.
  { pattern: '/', view: 'chat', load: placeholder, redirect: chatHomePath },
  { pattern: '/chat', view: 'chat', load: () => import('../routes/chat/session-list.svelte') },
  // `/chat/new` is registered before `/chat/:sessionId`: the first match wins.
  { pattern: '/chat/new', view: 'chat', load: () => import('../routes/chat/index.svelte') },
  {
    pattern: '/chat/:sessionId',
    view: 'chat',
    load: () => import('../routes/chat/index.svelte'),
  },
  { pattern: '/agents', view: 'agents', load: () => import('../routes/agents/agent-list.svelte') },
  // `new` is a path segment, not an agent: this route comes before `/agents/:id`.
  { pattern: '/agents/new', view: 'agent-editor', load: agentEditor },
  { pattern: '/agents/:id/edit', view: 'agent-editor', load: agentEditor },
  {
    pattern: '/agents/:id',
    view: 'agents',
    load: () => import('../routes/agents/agent-detail.svelte'),
  },
  // `/workflows` is the catalog of workflow definitions, and under it one type's page, its runs, and
  // its editor. A run lives under `/runs`. One component dispatches on the pattern.
  { pattern: '/workflows', view: 'workflows', load: workflowArea },
  { pattern: '/workflows/:type', view: 'workflows', load: workflowArea },
  { pattern: '/workflows/:type/runs', view: 'workflows', load: workflowArea },
  { pattern: '/workflows/:type/edit', view: 'workflows', load: workflowArea },
  { pattern: '/runs', view: 'runs', load: () => import('../routes/workflows/index.svelte') },
  { pattern: '/runs/:id', view: 'runs', load: () => import('../routes/workflows/index.svelte') },
  // The list, and one schedule's page: one component dispatches on whether the path names one.
  { pattern: '/schedules', view: 'schedules', load: schedulesArea },
  { pattern: '/schedules/:id', view: 'schedules', load: schedulesArea },
  { pattern: '/inbox', view: 'inbox', load: () => import('../routes/reviews/index.svelte') },
  { pattern: '/workers', view: 'workers', load: () => import('../routes/workers/index.svelte') },
  { pattern: '/storage', view: 'storage', load: () => import('../routes/storage/index.svelte') },
  { pattern: '/system', view: 'system', load: () => import('../routes/system/index.svelte') },
  { pattern: '/audit', view: 'audit', load: () => import('../routes/audit/index.svelte') },
  { pattern: '/engine', view: 'engine', load: () => import('../routes/dashboard/index.svelte') },
];
