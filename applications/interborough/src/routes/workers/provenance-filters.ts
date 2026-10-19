/**
 * The bounded provenance filters `weft.tasks.diagnostics` accepts (COR-198),
 * kept in the Workers route's URL so a filtered view can be shared and reloaded.
 * The server matches each field against the identity recorded on the attempts
 * that executed a task, so the dashboard only passes the values through and
 * never joins them against live fleet state.
 *
 * @module
 */
import {
  PROVENANCE_FILTER_FIELDS,
  type ProvenanceFilterField,
  type TaskProvenanceFilters,
} from './worker-catalog-types.ts';

export const PROVENANCE_FILTER_LABEL: Readonly<Record<ProvenanceFilterField, string>> = {
  deploymentName: 'Deployment name',
  buildId: 'Build ID',
  artifactDigest: 'Artifact digest',
  workerId: 'Worker ID',
  workflowRevision: 'Workflow revision',
};

/** Reads the filters from a URL's search params; blank values mean no filter. */
export function readProvenanceFilters(search: URLSearchParams): TaskProvenanceFilters {
  const filters: Partial<Record<ProvenanceFilterField, string>> = {};
  for (const field of PROVENANCE_FILTER_FIELDS) {
    const value = search.get(field)?.trim();
    if (value) filters[field] = value;
  }
  return filters;
}

/** Writes the filters onto search params, replacing any previous ones. */
export function writeProvenanceFilters(
  params: URLSearchParams,
  filters: TaskProvenanceFilters,
): URLSearchParams {
  for (const field of PROVENANCE_FILTER_FIELDS) {
    const value = filters[field]?.trim();
    if (value) params.set(field, value);
    else params.delete(field);
  }
  return params;
}

export function hasProvenanceFilters(filters: TaskProvenanceFilters): boolean {
  return PROVENANCE_FILTER_FIELDS.some((field) => Boolean(filters[field]));
}

/** The Workers list deep link that selects one worker (`worker-list-view.svelte`'s pattern). */
export function workerDeepLink(workerId: string): string {
  const params = new URLSearchParams({ tab: 'list', worker: workerId });
  return `/workers?${params.toString()}`;
}

/** The Diagnostics deep link that opens one task's ledger. */
export function taskLedgerDeepLink(operationId: string): string {
  const params = new URLSearchParams({ tab: 'diagnostics', task: operationId });
  return `/workers?${params.toString()}`;
}
