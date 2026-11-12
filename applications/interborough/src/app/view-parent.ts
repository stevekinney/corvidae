import { VIEW_COPY } from './copy/view-pages.ts';
import { DESTINATIONS } from './shell/destinations.ts';
import type { ViewName } from './views.ts';

/** Where a person goes to leave a page of a view: the view's own list, and the words for it. */
export type ViewParent = {
  readonly label: string;
  readonly path: string;
};

/**
 * The views that are not a sidebar destination, and the page that holds them. Workers, Storage and
 * the audit log sit under Health; the agent editor belongs to Agents.
 */
const PARENT_PATHS: Readonly<Partial<Record<ViewName, { view: ViewName; path: string }>>> = {
  'agent-editor': { view: 'agents', path: '/agents' },
  workers: { view: 'workers', path: '/health/workers' },
  storage: { view: 'storage', path: '/health/storage' },
  audit: { view: 'audit', path: '/health/audit' },
};

/**
 * The list a page of `view` leads back to, for the "Back to Runs" and "Back to Home" buttons of
 * the not-found and forbidden pages. Its label is the view's name in the sidebar.
 */
export function viewParent(view: ViewName): ViewParent {
  const held = PARENT_PATHS[view];
  if (held !== undefined) return { label: VIEW_COPY[held.view].label, path: held.path };
  const destination = DESTINATIONS.find((entry) => entry.view === view);
  return { label: VIEW_COPY[view].label, path: destination?.path ?? '/' };
}
