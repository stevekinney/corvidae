/**
 * What a workflow step can call, as the Bureau's workflow catalog lists it (`bureau.workflows.catalog`,
 * the catalog the agent tool `workflows-catalog` returns): each activity (a plugin's `plugin:name`, or
 * `agent`) and each code workflow a plugin contributed, with the `title` an editor calls it and the
 * JSON Schema of its `input`, parsed at the boundary. A step `{ kind: 'activity', handler, input }`
 * names an activity by its `id`, and a step `{ kind: 'workflow', workflow, input }` a workflow by its
 * `id`.
 *
 * This is the builder's only read of the catalog, so where the Bureau serves it is one function
 * (`readWorkflowCatalog`) and the builder has one loading and one failed state for both lists. A host
 * that does not answer the read gives a fault, and the builder says the list did not load, never that
 * no activity exists.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const schemaOfInput = z.record(z.string(), z.unknown());

const activitySchema = z.object({
  id: z.string(),
  /** What the editor calls the activity. `null` for an activity that declared no title. */
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** The JSON Schema of the step's `input`, or `null` when the activity declares none. */
  inputSchema: schemaOfInput.nullable(),
});

const workflowSchema = z.object({
  /** `plugin:name`, the `workflow` of a `workflow` step. */
  id: z.string(),
  name: z.string(),
  title: z.string(),
  /** The JSON Schema of the step's `input`, or `null` when the workflow's registration declares none. */
  inputSchema: schemaOfInput.nullable(),
});

const catalogSchema = z.object({
  activities: z.array(activitySchema),
  workflows: z.array(workflowSchema),
});

/** One activity a step can call. */
export type CatalogActivity = z.infer<typeof activitySchema>;

/** One code workflow a plugin contributed, which a `workflow` step can start. */
export type CatalogWorkflow = z.infer<typeof workflowSchema>;

/** What a step can call: the activities, and the code workflows, in the order the Bureau lists them. */
export type WorkflowCatalog = z.infer<typeof catalogSchema>;

/** The activities and the code workflows a step can call. */
export async function readWorkflowCatalog(options?: Options): Promise<WorkflowCatalog> {
  return catalogSchema.parse(await callBureau('bureau.workflows.catalog', {}, options));
}

/** The id of the built-in activity that runs an agent, which the builder draws as its own card. */
export const AGENT_ACTIVITY_ID = 'agent';
