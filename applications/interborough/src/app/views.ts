import type { AuthorizationScope } from '../lib/scopes.svelte.ts';

/**
 * Every view Interborough has. A view is what a sidebar entry opens, and it owns states besides
 * its content: loading, empty, error, forbidden, and, for one that opens an item by its address,
 * not found (`view-frame.svelte`). Several routes
 * can render one view, such as a run's list and one run's detail.
 */
export const VIEW_NAMES = [
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
 * How tightly a view lays out its rows and cards: `comfortable` for the pages a person reads and
 * decides on (rows 56px, cards 16px), `compact` for the operator tables (rows 40px, cards 12px).
 * The shell writes it to the page outlet as `data-density`, and Cinder's density tokens
 * follow it.
 */
export const VIEW_DENSITIES = ['comfortable', 'compact'] as const;

export type ViewDensity = (typeof VIEW_DENSITIES)[number];

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
  /** How tightly the view lays out its rows and cards. */
  readonly density: ViewDensity;
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
};

export const VIEWS: Readonly<Record<ViewName, ViewDefinition>> = {
  chat: { density: 'comfortable', scopes: [], canBeEmpty: true },
  agents: { density: 'comfortable', scopes: [], canBeEmpty: true },
  // `/agents/new` and `/agents/:agent/edit`. Never empty: it is where an agent is made.
  'agent-editor': { density: 'comfortable', scopes: [], canBeEmpty: false },
  // The tools and skills agents can use. Never empty as a view: each tab says its own nothing.
  capabilities: { density: 'comfortable', scopes: [], canBeEmpty: false },
  // The catalog of definitions, and under it one type's page, its runs, and its editor. It can be
  // empty when neither the engine nor the Bureau lists a workflow, and a type's runs can be empty.
  workflows: {
    density: 'comfortable',
    scopes: ['workflows:read'],
    canBeEmpty: true,
  },
  // The list and one run's page read the Bureau's tasks and goals, which hold no console scope. Only
  // the workflow sections of a run, the start picker, and the aggregate view read the engine, and they say
  // so themselves when the caller may not.
  runs: {
    density: 'compact',
    scopes: [],
    canBeEmpty: true,
    creating: (search) => search.get('view') === 'start',
  },
  schedules: {
    density: 'comfortable',
    scopes: ['schedules:read'],
    canBeEmpty: true,
  },
  // What is waiting on the caller. It holds no console scope: the console drops the Bureau's, and
  // the Bureau answers the caller its own reviews. The page shows its own empty state, because
  // the engine's reviews are listed beside the Bureau's and the probe asks only the Bureau.
  reviews: { density: 'comfortable', scopes: [], canBeEmpty: false },
  workers: { density: 'compact', scopes: ['system:read'], canBeEmpty: false },
  storage: { density: 'compact', scopes: ['storage:admin'], canBeEmpty: false },
  // Holds no console scope: the Bureau shows each caller the records about what it owns, and a
  // principal that may see none is answered with an empty page, so owner scoping is the gate.
  audit: { density: 'compact', scopes: [], canBeEmpty: true },
  // The Bureau's runtime settings. They are deployment-wide, so no owner scopes them, and the view
  // holds no console scope: the Bureau answers the scopes it declares. It always has something to show.
  settings: { density: 'comfortable', scopes: [], canBeEmpty: false },
  // In the sidebar after Schedules. Holds no console scope, as the audit trail holds none: a caller
  // sees the goals it owns. `/goals/new` is where the first goal is made, so it is never empty.
  goals: { density: 'comfortable', scopes: [], canBeEmpty: true },
  // In the sidebar after Capabilities. Holds no console scope: a caller sees the hooks it owns. A home that
  // keeps hooks off answers the page's own words, not the frame's. `/hooks/new` is where the first
  // hook is made, so the frame never calls the view empty there.
  hooks: { density: 'comfortable', scopes: [], canBeEmpty: true },
  // The operator's page: `system:read` alone reaches it, and so does `workflows:read` alone. Each
  // count and band that needs a scope the caller lacks shows a dash instead of failing the page.
  health: { density: 'compact', scopes: ['system:read', 'workflows:read'], canBeEmpty: false },
};
