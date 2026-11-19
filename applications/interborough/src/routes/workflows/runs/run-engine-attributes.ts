/**
 * The engine's search attribute operations as the attributes panel reads them, and whether a run
 * has anything for the run page's Versioning tab (COR-2424, row 54i).
 */
import type { HttpClient, WorkflowState } from '@lostgradient/weft';

import type { AttributesClient } from '../detail/attributes/attributes-data.ts';

/** The attribute operations of `client`, or `undefined` for an engine that lacks either. */
export function attributesClientOf(client: HttpClient): AttributesClient | undefined {
  const get = client.operations['weft.workflows.attributes.get'];
  const set = client.operations['weft.workflows.attributes.set'];
  return get === undefined || set === undefined
    ? undefined
    : {
        operations: {
          'weft.workflows.attributes.get': get,
          'weft.workflows.attributes.set': set,
        },
      };
}

/**
 * Whether a run has something for the Versioning tab: a worker version it is bound to, or a run it
 * replaced or was forked from. A run with none has no Versioning tab.
 */
export function hasVersioning(workflow: WorkflowState): boolean {
  return (
    workflow.workerBinding !== undefined ||
    workflow.forkedFrom !== undefined ||
    workflow.restartedFrom !== undefined
  );
}
