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
  'tasks',
  'reviews',
  'workers',
  'storage',
  'system',
  'audit',
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
   * Whether a later issue builds the view. A placeholder shows its empty state whenever the
   * service behind it answers, because there is nothing to show yet.
   */
  readonly placeholder: boolean;
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
  chat: { scopes: [], placeholder: false, canBeEmpty: true },
  agents: { scopes: [], placeholder: false, canBeEmpty: true },
  // `/agents/new` and `/agents/:id/edit`. Never empty: it is where an agent is made.
  'agent-editor': { scopes: [], placeholder: false, canBeEmpty: false },
  // The catalog of definitions, and under it one type's page, its runs, and its editor. It can be
  // empty when neither the engine nor the Bureau lists a workflow, and a type's runs can be empty.
  workflows: { scopes: ['workflows:read'], placeholder: false, canBeEmpty: true },
  runs: {
    scopes: ['workflows:read'],
    placeholder: false,
    canBeEmpty: true,
    creating: (search) => search.get('view') === 'start',
  },
  schedules: {
    scopes: ['schedules:read'],
    placeholder: false,
    canBeEmpty: true,
    creating: (search) => search.get('create') === '1',
  },
  // The tasks the Bureau shows the caller, and one task's page. It is not in the navigation: a
  // task is reached from the chat session it belongs to, from a run's page, and from a review.
  tasks: { scopes: [], placeholder: false, canBeEmpty: true },
  // What is waiting on the caller. It holds no console scope: the console drops the Bureau's, and
  // the Bureau answers the caller its own reviews. The page shows its own empty state, because
  // the engine's reviews are listed beside the Bureau's and the probe asks only the Bureau.
  reviews: { scopes: [], placeholder: false, canBeEmpty: false },
  workers: { scopes: ['system:read'], placeholder: false, canBeEmpty: false },
  storage: { scopes: ['storage:admin'], placeholder: false, canBeEmpty: false },
  system: { scopes: ['system:read'], placeholder: false, canBeEmpty: false },
  audit: { scopes: [], placeholder: true, canBeEmpty: true },
  engine: { scopes: ['workflows:read'], placeholder: false, canBeEmpty: false },
};
