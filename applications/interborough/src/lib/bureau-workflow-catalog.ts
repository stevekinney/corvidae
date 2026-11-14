/**
 * What a workflow step can call, as the Bureau's workflow catalog lists it: each activity (a plugin's
 * `plugin:name`, or `agent`) with the `title` an editor calls it, its description and the JSON Schema
 * of its `input` (`WorkflowCatalog.activities`, `packages/bureau/src/workflow-host.ts`), parsed at
 * the boundary. A step `{ kind: 'activity', handler, input }` names one by its `id`.
 *
 * This is the builder's only read of the catalog, so where the Bureau serves it is one function
 * (`readWorkflowCatalog`). The agent tool `workflows-catalog` returns it today; Bureau's JSON-RPC
 * surface has no operation for it yet, so a host that does not serve `bureau.workflows.catalog`
 * answers a fault and the builder says the list did not load, never that no activity exists.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const activitySchema = z.object({
  id: z.string(),
  /** What the editor calls the activity. `null` for an activity that declared no title. */
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** The JSON Schema of the step's `input`, or `null` when the activity declares none. */
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
});

const catalogSchema = z.object({ activities: z.array(activitySchema) });

/** One activity a step can call. */
export type CatalogActivity = z.infer<typeof activitySchema>;

/** The activities a step can call, in the order the Bureau lists them. */
export async function readWorkflowCatalog(options?: Options): Promise<readonly CatalogActivity[]> {
  return catalogSchema.parse(await callBureau('bureau.workflows.catalog', {}, options)).activities;
}

/** The id of the built-in activity that runs an agent, which the builder draws as its own card. */
export const AGENT_ACTIVITY_ID = 'agent';
