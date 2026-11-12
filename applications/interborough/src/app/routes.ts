import type { Component } from 'svelte';

import { AGENT_PAGE_COPY } from './copy/agents.ts';
import { CAPABILITIES_COPY } from './copy/capabilities.ts';
import { SETTINGS_SECTION_COPY } from './copy/settings.ts';
import { VIEW_COPY } from './copy/view-pages.ts';
import { WORKFLOW_COPY } from './copy/workflows.ts';
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
  /**
   * A last crumb for the page itself, after the trail its path makes: `/settings` is the section
   * General of Settings, so it reads "Settings › General" although its path has one segment.
   */
  leafCrumb?: string;
  /**
   * A crumb that comes before the trail the path makes, for a page whose address is one segment
   * deep but that belongs under another page: `/internal-workflows` keeps a path of its own so a
   * workflow named `internal` keeps its page, and reads "Workflows › Internal". The parent links
   * to its own path, never to this page's.
   */
  parent?: { readonly label: string; readonly path: string };
  /** Lazily imports the route's default-exported Svelte component. */
  load: () => Promise<{ default: Component }>;
  /**
   * Where the route goes instead of rendering, decided when it is opened. The outlet replaces the
   * history entry with the path this resolves, so Back does not return to the redirecting address.
   */
  redirect?: (match: { params: Readonly<Record<string, string | undefined>> }) => Promise<string>;
}

const agentEditor = () => import('../routes/agent-editor/index.svelte');
const agentPage = () => import('../routes/agents/agent-detail.svelte');
const workflowArea = () => import('../routes/workflow-definitions/index.svelte');
const runArea = () => import('../routes/workflows/index.svelte');
const schedulesArea = () => import('../routes/schedules/index.svelte');

export const routes: readonly RouteDefinition[] = [
  // Home is the page at `/`, the first item in the sidebar. It has no crumb: the trail for `/` is
  // the view's name.
  {
    pattern: '/',
    kind: 'overview',
    view: 'home',
    load: () => import('../routes/home/index.svelte'),
  },
  // Chat sessions live under `/chats/:chat`.
  {
    pattern: '/chats',
    kind: 'list-detail',
    crumb: VIEW_COPY.chat.label,
    view: 'chat',
    load: () => import('../routes/chat/chats.svelte'),
  },
  // `/chats/new` is registered before `/chats/:chat`: the first match wins.
  {
    pattern: '/chats/new',
    kind: 'list-detail',
    crumb: 'New chat',
    view: 'chat',
    load: () => import('../routes/chat/chats.svelte'),
  },
  {
    pattern: '/chats/:chat',
    kind: 'list-detail',
    crumb: { param: 'chat' },
    view: 'chat',
    load: () => import('../routes/chat/chats.svelte'),
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
  // An agent's page and its tabs (`lib/agent-paths.ts`, `AGENT_TABS`): one frame with one header,
  // so every tab is the same component, view and width, and only the tab body changes. Chats is
  // the agent's own address; each other tab is a path under it, so a reload and the breadcrumb keep
  // the place. Memory holds a list with the open memory beside it (`?selected=`), so the frame is
  // wide on every tab and the header does not move between them.
  {
    pattern: '/agents/:agent',
    kind: 'table',
    crumb: { param: 'agent' },
    view: 'agents',
    load: agentPage,
  },
  {
    pattern: '/agents/:agent/instructions',
    kind: 'table',
    crumb: AGENT_PAGE_COPY.tabs.instructions,
    view: 'agents',
    load: agentPage,
  },
  {
    pattern: '/agents/:agent/access',
    kind: 'table',
    crumb: AGENT_PAGE_COPY.tabs.access,
    view: 'agents',
    load: agentPage,
  },
  {
    pattern: '/agents/:agent/hooks',
    kind: 'table',
    crumb: AGENT_PAGE_COPY.tabs.hooks,
    view: 'agents',
    load: agentPage,
  },
  {
    pattern: '/agents/:agent/memory',
    kind: 'list-detail',
    crumb: AGENT_PAGE_COPY.tabs.memory,
    view: 'agents',
    load: agentPage,
  },
  {
    pattern: '/agents/:agent/settings',
    kind: 'table',
    crumb: AGENT_PAGE_COPY.tabs.settings,
    view: 'agents',
    load: agentPage,
  },
  // The tools and skills agents can use: Tools and Skills tabs, each a list with the open item beside it.
  {
    pattern: '/capabilities',
    kind: 'list-detail',
    crumb: VIEW_COPY.capabilities.label,
    view: 'capabilities',
    load: () => import('../routes/capabilities/index.svelte'),
  },
  // Connect tools is a page under Capabilities, not a dialog (design rows 33a to 33c): a form in the
  // 720px reading column, whose breadcrumb "Capabilities › Connect tools" is the way back.
  {
    pattern: '/capabilities/connect',
    kind: 'form',
    crumb: CAPABILITIES_COPY.source.connect.title,
    view: 'capabilities',
    load: () => import('../routes/capabilities/connect-tools.svelte'),
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
    crumb: WORKFLOW_COPY.internal.crumb,
    parent: { label: VIEW_COPY.workflows.label, path: '/workflows' },
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
  // Setting up one run of the workflow in the path: its input, and whether it starts now or on a schedule.
  {
    pattern: '/workflows/:workflow/run',
    kind: 'form',
    crumb: WORKFLOW_COPY.runSetup.crumb,
    view: 'workflows',
    load: workflowArea,
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
  // `new` is a path segment, not a run: step one of starting a run, before `/runs/:run`.
  {
    pattern: '/runs/new',
    kind: 'form',
    crumb: 'Start a run',
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
  // The list, the page that makes a schedule, one schedule's page (its runs with the details card
  // beside them, so it takes the width of a table), and the page that edits its cadence: one
  // component dispatches on what the path names. `new` is a path segment, not a
  // schedule: its route comes before `/schedules/:schedule`.
  {
    pattern: '/schedules',
    kind: 'table',
    crumb: VIEW_COPY.schedules.label,
    view: 'schedules',
    load: schedulesArea,
  },
  {
    pattern: '/schedules/new',
    kind: 'form',
    crumb: 'New schedule',
    view: 'schedules',
    load: schedulesArea,
  },
  {
    pattern: '/schedules/:schedule',
    kind: 'table',
    crumb: { param: 'schedule' },
    view: 'schedules',
    load: schedulesArea,
  },
  {
    pattern: '/schedules/:schedule/edit',
    kind: 'form',
    crumb: 'Edit',
    view: 'schedules',
    load: schedulesArea,
  },
  {
    pattern: '/reviews',
    kind: 'list-detail',
    crumb: VIEW_COPY.reviews.label,
    view: 'reviews',
    load: () => import('../routes/reviews/index.svelte'),
  },
  // The caller's hooks, the page that makes one, and one hook's editor with its recent deliveries.
  // `new` is a path segment, not a hook: its route comes before `/hooks/:hook`. The new hook page is
  // a form at reading width (sweep S56); a saved hook is an editor, which has the delivery log beside
  // its steps.
  {
    pattern: '/hooks',
    kind: 'table',
    crumb: VIEW_COPY.hooks.label,
    view: 'hooks',
    load: () => import('../routes/hooks/index.svelte'),
  },
  {
    pattern: '/hooks/new',
    kind: 'form',
    crumb: 'New hook',
    view: 'hooks',
    load: () => import('../routes/hooks/index.svelte'),
  },
  {
    pattern: '/hooks/:hook',
    kind: 'editor',
    crumb: { param: 'hook' },
    view: 'hooks',
    load: () => import('../routes/hooks/index.svelte'),
  },
  // The list of goals, the page that makes one, one goal with its attempts, and the page that
  // changes it. `new` is a path segment, not a goal: its route comes before `/goals/:goal`.
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
  {
    pattern: '/goals/:goal/edit',
    kind: 'form',
    crumb: 'Edit',
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
  // Settings, and its sections (`settings-sections.ts`). They are full-width pages: the section
  // navigation is a column beside one reading column, which `settings-frame.svelte` sets.
  {
    pattern: '/settings',
    kind: 'editor',
    crumb: VIEW_COPY.settings.label,
    leafCrumb: SETTINGS_SECTION_COPY.general,
    view: 'settings',
    load: () => import('../routes/settings/index.svelte'),
  },
  {
    pattern: '/settings/models',
    kind: 'editor',
    crumb: SETTINGS_SECTION_COPY.models,
    view: 'settings',
    load: () => import('../routes/settings/models/index.svelte'),
  },
  {
    pattern: '/settings/allowed-models',
    kind: 'editor',
    crumb: SETTINGS_SECTION_COPY.modelPolicy,
    view: 'settings',
    load: () => import('../routes/settings/allowed-models.svelte'),
  },
  {
    pattern: '/settings/a2a',
    kind: 'editor',
    crumb: SETTINGS_SECTION_COPY.a2a,
    view: 'settings',
    load: () => import('../routes/settings/a2a/index.svelte'),
  },
  {
    pattern: '/settings/plugins',
    kind: 'list-detail',
    crumb: SETTINGS_SECTION_COPY.plugins,
    view: 'settings',
    load: () => import('../routes/settings/plugins/index.svelte'),
  },
  {
    pattern: '/settings/data-and-retention',
    kind: 'editor',
    crumb: SETTINGS_SECTION_COPY.dataAndRetention,
    view: 'settings',
    load: () => import('../routes/settings/retention/index.svelte'),
  },
  {
    pattern: '/settings/api-reference',
    kind: 'table',
    crumb: SETTINGS_SECTION_COPY.apiReference,
    view: 'settings',
    load: () => import('../routes/settings/api-reference/index.svelte'),
  },
];
