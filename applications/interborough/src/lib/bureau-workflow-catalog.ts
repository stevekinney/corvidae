/**
 * What a workflow step can call, as the Bureau's workflow catalog lists it (`bureau.workflows.catalog`,
 * the catalog the agent tool `workflows-catalog` returns): each activity (a plugin's `plugin:name`, or
 * `agent`) and each code workflow a plugin contributed, with the `title` an editor calls it and the
 * JSON Schema of its `input`. A step `{ kind: 'activity', handler, input }` names an activity by its
 * `id`, and a step `{ kind: 'workflow', workflow, input }` a workflow by its `id`.
 *
 * This is the builder's only read of the catalog, so where the Bureau serves it is one function
 * (`readWorkflowCatalog`) and the builder has one loading and one failed state for both lists. A host
 * that does not answer the read gives a fault, and the builder says the list did not load, never that
 * no activity exists.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

type Catalog = BureauOutput<'bureau.workflows.catalog'>;

/** One activity a step can call. `title` is what the editor calls it, `null` for one that declared none. */
export type CatalogActivity = Catalog['activities'][number];

/** One code workflow a plugin contributed, which a `workflow` step can start. */
export type CatalogWorkflow = Catalog['workflows'][number];

/** What a step can call: the activities, and the code workflows, in the order the Bureau lists them. */
export type WorkflowCatalog = {
  /** The activities available to workflow definitions. */
  readonly activities: readonly CatalogActivity[];
  /** The workflows visible to the caller. */
  readonly workflows: readonly CatalogWorkflow[];
};

/** The activities and the code workflows a step can call. */
export async function readWorkflowCatalog(options?: Options): Promise<WorkflowCatalog> {
  const catalog = await bureauClient['bureau.workflows.catalog']({}, options);
  return { activities: catalog.activities, workflows: catalog.workflows };
}

/** The id of the built-in activity that runs an agent, which the builder draws as its own card. */
export const AGENT_ACTIVITY_ID = 'agent';
