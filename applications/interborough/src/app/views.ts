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
  'workflows',
  'runs',
  'schedules',
  'reviews',
  'workers',
  'storage',
  'system',
  'audit',
  'goals',
  'engine',
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

/**
 * The states a view can be in besides showing its content. `not-found` is for a view that opens
 * one item by the address, such as a chat session: an item that does not exist, and one the
 * caller may not see, both answer it, because the server does not tell them apart.
 */
export const VIEW_STATES = ['loading', 'empty', 'error', 'forbidden', 'not-found'] as const;

export type ViewStateName = (typeof VIEW_STATES)[number];

/** What a view needs from the principal before it asks the server anything. */
export type ViewDefinition = {
  /** The scopes the engine console gates the view on; none for a view Bureau serves. */
  readonly scopes: readonly AuthorizationScope[];
  /**
   * Whether the view can have nothing to show. A view that always has something, such as the
   * engine's workers page with its task ledger and deployments, has no empty state.
   */
  readonly canBeEmpty: boolean;
  /**
   * Whether the location is the view's way of creating its first item, such as the start wizard
   * on `/runs?view=start`. An empty view offers a link there, so the frame shows the view's own
   * content for that location instead of the empty state it just came from.
   */
  readonly creating?: (search: URLSearchParams) => boolean;
};

export const VIEWS: Readonly<Record<ViewName, ViewDefinition>> = {
  chat: { scopes: [], canBeEmpty: true },
  agents: { scopes: [], canBeEmpty: true },
  // `/agents/new` and `/agents/:id/edit`. Never empty: it is where an agent is made.
  'agent-editor': { scopes: [], canBeEmpty: false },
  // The catalog of definitions, and under it one type's page, its runs, and its editor. It can be
  // empty when neither the engine nor the Bureau lists a workflow, and a type's runs can be empty.
  workflows: { scopes: ['workflows:read'], canBeEmpty: true },
  runs: {
    scopes: ['workflows:read'],
    canBeEmpty: true,
    creating: (search) => search.get('view') === 'start',
  },
  schedules: {
    scopes: ['schedules:read'],
    canBeEmpty: true,
    creating: (search) => search.get('create') === '1',
  },
  // What is waiting on the caller. It holds no console scope: the console drops the Bureau's, and
  // the Bureau answers the caller its own reviews. The page shows its own empty state, because
  // the engine's reviews are listed beside the Bureau's and the probe asks only the Bureau.
  reviews: { scopes: [], canBeEmpty: false },
  workers: { scopes: ['system:read'], canBeEmpty: false },
  storage: { scopes: ['storage:admin'], canBeEmpty: false },
  system: { scopes: ['system:read'], canBeEmpty: false },
  // Holds no console scope: the Bureau shows each caller the records about what it owns, and a
  // principal that may see none is answered with an empty page, so owner scoping is the gate.
  audit: { scopes: [], canBeEmpty: true },
  // Reached by address and by the empty states that link to it, and not from the sidebar. Holds no
  // console scope, as the audit trail holds none: a caller sees the goals it owns.
  goals: {
    scopes: [],
    canBeEmpty: true,
    creating: (search) => search.get('create') === '1',
  },
  engine: { scopes: ['workflows:read'], canBeEmpty: false },
};
