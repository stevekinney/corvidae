/**
 * What the builder gives the step cards it draws: the file's text, the one way to change it, and
 * the answers of the Bureau's catalogs. The cards sit at any depth inside each other, so they take
 * these through Svelte's context instead of a prop each level passes on. The builder owns the
 * values; a card reads them where it draws and never keeps a copy.
 */
import { getContext, setContext } from 'svelte';

import type { CatalogActivity } from '../../lib/bureau-workflow-catalog.ts';
import type { CodeWorkflowListing } from '../../lib/workflow-files.ts';
import type { StepKeys } from './workflow-step-keys.svelte.ts';

/** A catalog the Bureau answers: loading, failed (with a way to ask again), or its entries. */
export type CatalogState<Entry> =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly retry: () => void }
  | { readonly status: 'ready'; readonly entries: readonly Entry[] };

/** A choice of a `Select`. */
export interface BuilderOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface BuilderHost {
  /** The file's text. */
  readonly text: string;
  /** Whether the form is read-only: on a phone, or while a save is in flight. */
  readonly locked: boolean;
  /** The keys the steps keep while their neighbours move. */
  readonly keys: StepKeys;
  /**
   * Writes `next` as the file's text. `follow` runs first when `next` differs from the text, to
   * move the steps' keys as the edit moved the steps. Text that is what it was writes nothing.
   */
  commit: (next: string, follow?: () => void) => void;
  /** The `error` prop a field takes for its problem, or nothing for a field that has none. */
  errorOf: (fieldId: string) => { error?: string };
  /** Whether the step at `address` has something to fix. */
  hasProblem: (address: string) => boolean;
  /** Whether the agents could not be listed, which leaves the agent to be typed. */
  readonly agentsFailed: boolean;
  /** The agents a step's select offers: the catalog, and the one the file names when it is not there. */
  agentOptions: (current: string) => BuilderOption[];
  /** Whether the agent needs a model while no provider is connected. */
  agentNeedsProvider: (agent: string) => boolean;
  /**
   * Asks for the catalogs below. They are read when a step needs one (an activity or a workflow
   * card) or when the add menu is opened, never for a workflow that has neither, so opening the
   * builder on a new workflow asks the Bureau for nothing.
   */
  requestCatalogs: () => void;
  /** The activities a step can call, for the add menu and a card's input form. */
  readonly activities: CatalogState<CatalogActivity>;
  /** The plugin code workflows a `workflow` step can start. */
  readonly workflows: CatalogState<CodeWorkflowListing>;
  /** What a person reads for an activity: its title, or its id in words. */
  activityTitle: (handler: string) => string;
  /** What a person reads for a workflow: its title, or its id in words. */
  workflowTitle: (id: string) => string;
}

const HOST = Symbol('workflow-builder-host');

/** Gives the cards below the builder their host. */
export function provideBuilderHost(host: BuilderHost): void {
  setContext(HOST, host);
}

/** The host a card reads. A card is only ever drawn inside the builder, so there is always one. */
export function useBuilderHost(): BuilderHost {
  const host = getContext<BuilderHost | undefined>(HOST);
  if (host === undefined) throw new Error('A step card is drawn inside the workflow builder.');
  return host;
}
