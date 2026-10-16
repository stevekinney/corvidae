// The UI's stylesheet travels with the entry: importing anything from
// `@lostgradient/weft/ui` brings it (`documentation/weft-ui-public-surface.md`, CSS).
import './styles/index.css';

// The exports below are exactly the list in `documentation/weft-ui-public-surface.md`,
// which `public-surface.test.ts` compares with this module. Every name is named
// explicitly, so a new export from one of the source modules never joins the
// published surface by accident.

export { default as WeftDashboard } from './app/app.svelte';

export { default as DashboardView } from './views/dashboard-view.svelte';
export { default as ReviewsView } from './views/reviews-view.svelte';
export { default as SchedulesView } from './views/schedules-view.svelte';
export { default as StorageView } from './views/storage-view.svelte';
export { default as SystemView } from './views/system-view.svelte';
export { default as WorkersView } from './views/workers-view.svelte';
export { default as WorkflowsView } from './views/workflows-view.svelte';

export { createClient, getClient, provideClient, setApiKey } from './lib/client.ts';
export { readRuntimeConfig, type WeftUiRuntimeConfig } from './lib/config.ts';
export {
  FleetEventSource,
  PollingSource,
  WorkflowTailSource,
  computeReconnectDelayMs,
  isTerminalWorkflowEventType,
  workflowStatusForEventType,
  type FleetEventFilter,
  type FleetEventFrame,
  type FleetEventSourceConfig,
  type LiveSource,
  type LiveSourceStatus,
  type PollingSourceOptions,
  type WorkflowEventTailOpener,
  type WorkflowTailSourceOptions,
} from './lib/live-source/index.ts';
export { createQueryClient, queryKeys, type WorkflowAggregateGroupBy } from './lib/query.ts';
export {
  matchRoute,
  router,
  workflowDetailPath,
  type RouteMatch,
  type RouteState,
} from './lib/router.svelte.ts';
