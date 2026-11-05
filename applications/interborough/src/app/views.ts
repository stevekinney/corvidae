import type { AuthorizationScope } from '../lib/scopes.svelte.ts';

/**
 * Every view Interborough has. A view is what a sidebar entry opens, and it owns states besides
 * its content: loading, empty, error, forbidden, and, for one that opens an item by its address,
 * not found (`view-frame.svelte`). Several routes
 * can render one view, such as a run's list and one run's detail.
 */
export const VIEW_NAMES = [
  'home',
  'chat',
  'agents',
  'agent-editor',
  'capabilities',
  'workflows',
  'runs',
  'schedules',
  'reviews',
  'workers',
  'storage',
  'audit',
  'settings',
  'goals',
  'hooks',
  'health',
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

/**
 * The states a view can be in besides showing its content. `not-found` is for a view that opens
 * one item by the address, such as a chat session: an item that does not exist, and one the
 * caller may not see, both answer it, because the server does not tell them apart.
 */
export const VIEW_STATES = ['loading', 'empty', 'error', 'forbidden', 'not-found'] as const;

export type ViewStateName = (typeof VIEW_STATES)[number];

/**
 * What kind of page a route is (design row 17f). A page's width follows its kind, not its area:
 * `list-detail` is a list with the open item beside it, `table` is a page of rows read across,
 * `editor` is an editor with a side panel, `form` is a form filled in from top to bottom, and
 * `reading` is prose and cards read down the page.
 */
export const PAGE_KINDS = ['list-detail', 'table', 'editor', 'form', 'reading'] as const;

export type PageKind = (typeof PAGE_KINDS)[number];

/**
 * How wide a page is: `reading` centres it in Cinder's 760px reading column, and `full` gives it
 * the whole width of the outlet. The shell writes it to the outlet as `data-width`.
 */
export const VIEW_WIDTHS = ['reading', 'full'] as const;

export type ViewWidth = (typeof VIEW_WIDTHS)[number];

/**
 * The width of a kind of page: a list with its detail, a table and an editor with a side panel
 * need the room, and a form or prose keeps the reading width.
 */
export function pageWidth(kind: PageKind): ViewWidth {
  return kind === 'form' || kind === 'reading' ? 'reading' : 'full';
}

/** What a view needs from the principal before it asks the server anything. */
export type ViewDefinition = {
  /**
   * The scopes the engine console gates the view on, any one of which opens it; none for a view
   * Bureau serves.
   */
  readonly scopes: readonly AuthorizationScope[];
  /**
   * Whether the view can have nothing to show. A view that always has something, such as the
   * engine's workers page with its task ledger and deployments, has no empty state.
   */
  readonly canBeEmpty: boolean;
  /**
   * Whether the location is the view's way of creating its first item, such as the start picker
   * on `/runs?view=start`. An empty view offers a link there, so the frame shows the view's own
   * content for that location instead of the empty state it just came from.
   */
  readonly creating?: (search: URLSearchParams) => boolean;
  /**
   * Whether the page draws its own loading, empty, failed and refresh-failed states under its own
   * header, which a list page needs (its heading, its filter bar and its "+" stay in every state).
   * The frame still probes and still says what it learned in `data-state`, and it still refuses
   * (forbidden, not found), but it renders the page in every other state instead of replacing it,
   * and it draws no refresh error above it. The page reads its words from `VIEW_COPY`, so the
   * frame and the page never say them two ways.
   */
  readonly ownsStates?: boolean;
};

export const VIEWS: Readonly<Record<ViewName, ViewDefinition>> = {
  // The page at `/`, first in the sidebar. It reads what other views read, each card on its own, so
  // the view itself has nothing to probe and is never empty.
  home: { scopes: [], canBeEmpty: false },
  chat: { scopes: [], canBeEmpty: true },
  agents: { scopes: [], canBeEmpty: true },
  // `/agents/new` and `/agents/:agent/edit`. Never empty: it is where an agent is made.
  'agent-editor': { scopes: [], canBeEmpty: false },
  // The tools and skills agents can use. Never empty as a view: each tab says its own nothing.
  capabilities: { scopes: [], canBeEmpty: false },
  // The catalog of definitions, and under it one type's page, its runs, and its editor. It can be
  // empty when neither the engine nor the Bureau lists a workflow, and a type's runs can be empty.
  workflows: {
    scopes: ['workflows:read'],
    canBeEmpty: true,
  },
  // The list and one run's page read the Bureau's tasks and goals, which hold no console scope. Only
  // the workflow sections of a run, the start picker, and the aggregate view read the engine, and they say
  // so themselves when the caller may not.
  runs: {
    scopes: [],
    canBeEmpty: true,
    creating: (search) => search.get('view') === 'start',
  },
  schedules: {
    scopes: ['schedules:read'],
    canBeEmpty: true,
    ownsStates: true,
  },
  // What is waiting on the caller. It holds no console scope: the console drops the Bureau's, and
  // the Bureau answers the caller its own reviews. The page shows its own empty state, because
  // the engine's reviews are listed beside the Bureau's and the probe asks only the Bureau.
  reviews: { scopes: [], canBeEmpty: false },
  workers: { scopes: ['system:read'], canBeEmpty: false },
  storage: { scopes: ['storage:admin'], canBeEmpty: false },
  // Holds no console scope: the Bureau shows each caller the records about what it owns, and a
  // principal that may see none is answered with an empty page, so owner scoping is the gate.
  audit: { scopes: [], canBeEmpty: true },
  // The Bureau's runtime settings. They are deployment-wide, so no owner scopes them, and the view
  // holds no console scope: the Bureau answers the scopes it declares. It always has something to show.
  settings: { scopes: [], canBeEmpty: false },
  // In the sidebar after Schedules. Holds no console scope, as the audit trail holds none: a caller
  // sees the goals it owns. `/goals/new` is where the first goal is made, so it is never empty.
  goals: { scopes: [], canBeEmpty: true },
  // In the sidebar after Capabilities. Holds no console scope: a caller sees the hooks it owns. A home that
  // keeps hooks off answers the page's own words, not the frame's. `/hooks/new` is where the first
  // hook is made, so the frame never calls the view empty there.
  hooks: { scopes: [], canBeEmpty: true },
  // The operator's page: `system:read` alone reaches it, and so does `workflows:read` alone. Each
  // count and band that needs a scope the caller lacks shows a dash instead of failing the page.
  health: { scopes: ['system:read', 'workflows:read'], canBeEmpty: false },
};
