import type { Component } from 'svelte';

import { chatHomePath } from '../routes/chat/chat-home.ts';
import { SETTINGS_SECTION_COPY, VIEW_COPY, WORKFLOW_COPY } from './copy.ts';
import type { PageKind, ViewName } from './views.ts';

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
  /** Path pattern, e.g. `/runs/:run`. */
  pattern: string;
  /** The view this route renders. The outlet wraps the route in that view's frame. */
  view?: ViewName;
  /** What kind of page the route is, which sets its width (`views.ts`, `pageWidth`). */
  kind: PageKind;
  /**
   * The route's entry in the top bar's breadcrumb trail: fixed words, or the name of the path
   * parameter whose value it shows until the page supplies a label (`breadcrumbs.svelte.ts`). A
   * route with none, such as a redirect, is left out of the trail.
   */
  crumb?: string | { readonly param: string };
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
const runArea = () => import('../routes/workflows/index.svelte');
const schedulesArea = () => import('../routes/schedules/index.svelte');

export const routes: readonly RouteDefinition[] = [
  // Chat is the home screen. Sessions live under `/chats/:chat`.
  // `/` opens the most recently updated session, or `/chats` when there is none.
  { pattern: '/', kind: 'reading', view: 'chat', load: placeholder, redirect: chatHomePath },
  {
    pattern: '/chats',
    kind: 'reading',
    crumb: VIEW_COPY.chat.label,
    view: 'chat',
    load: () => import('../routes/chat/session-list.svelte'),
  },
  // `/chats/new` is registered before `/chats/:chat`: the first match wins.
  {
    pattern: '/chats/new',
    kind: 'reading',
    crumb: 'New chat',
    view: 'chat',
    load: () => import('../routes/chat/index.svelte'),
  },
  {
    pattern: '/chats/:chat',
    kind: 'reading',
    crumb: { param: 'chat' },
    view: 'chat',
    load: () => import('../routes/chat/index.svelte'),
  },
  {
    pattern: '/agents',
    kind: 'table',
    crumb: VIEW_COPY.agents.label,
    view: 'agents',
    load: () => import('../routes/agents/agent-list.svelte'),
  },
  // `new` is a path segment, not an agent: this route comes before `/agents/:agent`.
  {
    pattern: '/agents/new',
    kind: 'editor',
    crumb: 'New agent',
    view: 'agent-editor',
    load: agentEditor,
  },
  {
    pattern: '/agents/:agent/edit',
    kind: 'editor',
    crumb: 'Edit',
    view: 'agent-editor',
    load: agentEditor,
  },
  // What an agent remembers. It keeps the `agents` view, whose frame probes the memory too.
  {
    pattern: '/agents/:agent/memories',
    kind: 'list-detail',
    crumb: 'Memory',
    view: 'agents',
    load: () => import('../routes/agents/agent-memory.svelte'),
  },
  {
    pattern: '/agents/:agent',
    kind: 'reading',
    crumb: { param: 'agent' },
    view: 'agents',
    load: () => import('../routes/agents/agent-detail.svelte'),
  },
  // The tools and skills agents can use: Tools and Skills tabs, each a list with the open item beside it.
  {
    pattern: '/capabilities',
    kind: 'list-detail',
    crumb: VIEW_COPY.capabilities.label,
    view: 'capabilities',
    load: () => import('../routes/capabilities/index.svelte'),
  },
  // `/workflows` is the catalog of workflow definitions, and under it one type's page, its runs, and
  // its editor. One component dispatches on the pattern. A run reached from its workflow is under
  // it, and `/runs/:run` is the same page for a run known by its ID alone.
  {
    pattern: '/workflows',
    kind: 'table',
    crumb: VIEW_COPY.workflows.label,
    view: 'workflows',
    load: workflowArea,
  },
  // `new` is a path segment, not a workflow: this route comes before `/workflows/:workflow`.
  {
    pattern: '/workflows/new',
    kind: 'form',
    crumb: 'New workflow',
    view: 'workflows',
    load: workflowArea,
  },
  // The types Interborough runs itself. A path of its own, so a workflow named `internal` keeps its page.
  {
    pattern: '/internal-workflows',
    kind: 'table',
    crumb: WORKFLOW_COPY.internal.title,
    view: 'workflows',
    load: workflowArea,
  },
  {
    pattern: '/workflows/:workflow',
    kind: 'reading',
    crumb: { param: 'workflow' },
    view: 'workflows',
    load: workflowArea,
  },
  {
    pattern: '/workflows/:workflow/runs',
    kind: 'reading',
    crumb: VIEW_COPY.runs.label,
    view: 'workflows',
    load: workflowArea,
  },
  {
    pattern: '/workflows/:workflow/runs/:run',
    kind: 'table',
    crumb: { param: 'run' },
    view: 'runs',
    load: runArea,
  },
  {
    pattern: '/workflows/:workflow/edit',
    kind: 'form',
    crumb: 'Edit',
    view: 'workflows',
    load: workflowArea,
  },
  {
    pattern: '/runs',
    kind: 'table',
    crumb: VIEW_COPY.runs.label,
    view: 'runs',
    load: runArea,
  },
  {
    pattern: '/runs/:run',
    kind: 'table',
    crumb: { param: 'run' },
    view: 'runs',
    load: runArea,
  },
  // The list, and one schedule's page: one component dispatches on whether the path names one.
  {
    pattern: '/schedules',
    kind: 'reading',
    crumb: VIEW_COPY.schedules.label,
    view: 'schedules',
    load: schedulesArea,
  },
  {
    pattern: '/schedules/:schedule',
    kind: 'reading',
    crumb: { param: 'schedule' },
    view: 'schedules',
    load: schedulesArea,
  },
  {
    pattern: '/reviews',
    kind: 'reading',
    crumb: VIEW_COPY.reviews.label,
    view: 'reviews',
    load: () => import('../routes/reviews/index.svelte'),
  },
  // The list of goals, the page that makes one, and one goal with its attempts. `new` is a path
  // segment, not a goal: its route comes before `/goals/:goal`.
  {
    pattern: '/goals',
    kind: 'table',
    crumb: VIEW_COPY.goals.label,
    view: 'goals',
    load: () => import('../routes/goals/index.svelte'),
  },
  {
    pattern: '/goals/new',
    kind: 'form',
    crumb: 'New goal',
    view: 'goals',
    load: () => import('../routes/goals/index.svelte'),
  },
  {
    pattern: '/goals/:goal',
    kind: 'table',
    crumb: { param: 'goal' },
    view: 'goals',
    load: () => import('../routes/goals/index.svelte'),
  },
  // Health is the engine's overview, and under it the engine's other pages.
  {
    pattern: '/health',
    kind: 'table',
    crumb: VIEW_COPY.health.label,
    view: 'health',
    load: () => import('../routes/health/index.svelte'),
  },
  // Every engine workflow across types, narrowed by `?status=`: where the Overview's counts open.
  {
    pattern: '/health/runs',
    kind: 'table',
    crumb: VIEW_COPY.runs.label,
    view: 'health',
    load: () => import('../routes/workflows/list/workflow-list.svelte'),
  },
  {
    pattern: '/health/workers',
    kind: 'table',
    crumb: VIEW_COPY.workers.label,
    view: 'workers',
    load: () => import('../routes/workers/index.svelte'),
  },
  {
    pattern: '/health/storage',
    kind: 'table',
    crumb: VIEW_COPY.storage.label,
    view: 'storage',
    load: () => import('../routes/storage/index.svelte'),
  },
  {
    pattern: '/health/audit',
    kind: 'table',
    crumb: VIEW_COPY.audit.label,
    view: 'audit',
    load: () => import('../routes/audit/index.svelte'),
  },
  // Settings, and its sections (`settings-sections.ts`).
  {
    pattern: '/settings',
    kind: 'form',
    crumb: VIEW_COPY.settings.label,
    view: 'settings',
    load: () => import('../routes/settings/index.svelte'),
  },
  {
    pattern: '/settings/data-and-retention',
    kind: 'form',
    crumb: SETTINGS_SECTION_COPY.dataAndRetention,
    view: 'settings',
    load: () => import('../routes/settings/data-and-retention.svelte'),
  },
  {
    pattern: '/settings/api-reference',
    kind: 'table',
    crumb: SETTINGS_SECTION_COPY.apiReference,
    view: 'settings',
    load: () => import('../routes/settings/api-reference.svelte'),
  },
];
