import type { Component } from 'svelte';

import { identifierPath } from '../lib/identifier-paths.ts';
import { chatHomePath } from '../routes/chat/chat-home.ts';
import type { ViewName } from './views.ts';

/**
 * The route registry: a path pattern, the view it renders, and a lazy import of the component
 * that renders it. `:id`-style segments are simple named params; the router
 * (`src/lib/router.svelte.ts`) owns matching semantics, and the first matching pattern wins.
 *
 * The host serves `index.html` for exactly these patterns (`src/host/host.ts`), so a route added
 * here is served there with no second list to edit. It also serves it for any other address a
 * browser navigates to (`src/host/shell-request.ts`), and the route outlet renders the not-found
 * view for the ones that match no pattern here.
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
  redirect?: (match: { params: Readonly<Record<string, string | undefined>> }) => Promise<string>;
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
  // What an agent remembers. It keeps the `agents` view, whose frame probes the memory too.
  {
    pattern: '/agents/:id/memory',
    view: 'agents',
    load: () => import('../routes/agents/agent-memory.svelte'),
  },
  {
    pattern: '/agents/:id',
    view: 'agents',
    load: () => import('../routes/agents/agent-detail.svelte'),
  },
  // `/workflows` is the catalog of workflow definitions, and under it one type's page, its runs, and
  // its editor. A run lives under `/runs`. One component dispatches on the pattern.
  { pattern: '/workflows', view: 'workflows', load: workflowArea },
  // `new` is a path segment, not a workflow: this route comes before `/workflows/:type`.
  { pattern: '/workflows/new', view: 'workflows', load: workflowArea },
  { pattern: '/workflows/:type', view: 'workflows', load: workflowArea },
  { pattern: '/workflows/:type/runs', view: 'workflows', load: workflowArea },
  { pattern: '/workflows/:type/edit', view: 'workflows', load: workflowArea },
  { pattern: '/runs', view: 'runs', load: () => import('../routes/workflows/index.svelte') },
  { pattern: '/runs/:id', view: 'runs', load: () => import('../routes/workflows/index.svelte') },
  // The list, and one schedule's page: one component dispatches on whether the path names one.
  { pattern: '/schedules', view: 'schedules', load: schedulesArea },
  { pattern: '/schedules/:id', view: 'schedules', load: schedulesArea },
  // A task is a run. Old addresses for one go to the run's page, or to the runs a chat started.
  {
    pattern: '/tasks',
    view: 'runs',
    load: placeholder,
    redirect: () => Promise.resolve('/runs?startedBy=chat'),
  },
  {
    pattern: '/tasks/:id',
    view: 'runs',
    load: placeholder,
    // `workflowDetailPath` lives in the router, which reads this table, so the path is built here.
    redirect: ({ params }) =>
      Promise.resolve(
        identifierPath('runs', '/runs/:id', params['id'] ?? '', new URLSearchParams()),
      ),
  },
  { pattern: '/reviews', view: 'reviews', load: () => import('../routes/reviews/index.svelte') },
  { pattern: '/workers', view: 'workers', load: () => import('../routes/workers/index.svelte') },
  { pattern: '/storage', view: 'storage', load: () => import('../routes/storage/index.svelte') },
  { pattern: '/system', view: 'system', load: () => import('../routes/system/index.svelte') },
  { pattern: '/audit', view: 'audit', load: () => import('../routes/audit/index.svelte') },
  { pattern: '/settings', view: 'settings', load: () => import('../routes/settings/index.svelte') },
  // Not in the sidebar: a goal is made and cancelled here, and linked to from where it is mentioned.
  { pattern: '/goals', view: 'goals', load: () => import('../routes/goals/index.svelte') },
  { pattern: '/engine', view: 'engine', load: () => import('../routes/dashboard/index.svelte') },
  // Every engine workflow across types, narrowed by `?status=`: where the Overview's counts open.
  {
    pattern: '/engine/runs',
    view: 'engine',
    load: () => import('../routes/workflows/list/workflow-list.svelte'),
  },
];
