/**
 * The runs related to one run: the run that started it (its parent), the runs it started (its
 * children), and the other runs its parent started (its siblings). The links are the engine's own
 * (`WorkflowState.parentWorkflowId`, and a list filtered by it), never guessed from names or times.
 *
 * A parent the engine no longer holds (it was purged) is still named, by id, so the run does not
 * look like it started by itself. Each side is read up to {@link RELATED_LIMIT} runs, with the
 * total, so a parent with hundreds of children is shown as a count and a few of them.
 */
import type { HttpClient, WorkflowState, WorkflowSummary } from '@lostgradient/weft';
import type { QueryKey } from '@tanstack/svelte-query';

import type { WorkflowActiveRevisionClient } from '../../../lib/workflow-revision.ts';

/** How many children or siblings are read; the rest are counted. */
export const RELATED_LIMIT = 50;

/** The run whose relatives are read: its identifier and the run that started it, if any. */
export interface RelatedRunSubject {
  readonly id: string;
  readonly parentWorkflowId?: string | undefined;
}

/** What the page needs of the client: the reads, and the catalog's active revision for the badge. */
export type RelatedRunsClient = Pick<HttpClient, 'get' | 'list'> & WorkflowActiveRevisionClient;

/** A run, as far as a link to it needs. */
export interface RelatedRun {
  readonly id: string;
  /** The workflow type; `undefined` for a parent the engine no longer holds. */
  readonly type: string | undefined;
  /** `undefined` for a parent the engine no longer holds. */
  readonly status: WorkflowSummary['status'] | undefined;
  readonly createdAt: number | undefined;
  /** The exact revision the run started against; `undefined` for a run from before revisions were pinned. */
  readonly revision?: string | undefined;
}

/** A page of related runs and how many there are in all. */
export interface RelatedGroup {
  readonly runs: readonly RelatedRun[];
  readonly total: number;
}

/** The related runs of one run. */
export interface RelatedRuns {
  /** The run that started this one, or `undefined` when none did. */
  readonly parent: RelatedRun | undefined;
  readonly children: RelatedGroup;
  readonly siblings: RelatedGroup;
}

/** The key of one run's related-runs read; its prefix is invalidated whenever any run changes. */
export function relatedRunsQueryKey(runId: string, parentId: string | undefined): QueryKey {
  return ['workflows', 'related', runId, parentId ?? ''];
}

function summarized(run: WorkflowSummary | WorkflowState): RelatedRun {
  return {
    id: run.id,
    type: run.type,
    status: run.status,
    createdAt: run.createdAt,
    revision: run.revision,
  };
}

/** Whether the run has any relative at all, so the section can say it has none. */
export function hasRelatedRuns(related: RelatedRuns): boolean {
  return related.parent !== undefined || related.children.total > 0 || related.siblings.total > 0;
}

/** Reads the parent, the children and the siblings of a run. */
export async function fetchRelatedRuns(
  client: RelatedRunsClient,
  run: RelatedRunSubject,
): Promise<RelatedRuns> {
  // Snapshot what the reads need: the caller's object can change while they are in flight.
  const { id: runId, parentWorkflowId: parentId } = run;
  const [parentState, childPage, siblingPage] = await Promise.all([
    parentId === undefined ? Promise.resolve(undefined) : client.get(parentId),
    client.list({ parentWorkflowId: runId, limit: RELATED_LIMIT }),
    parentId === undefined
      ? Promise.resolve(undefined)
      : client.list({ parentWorkflowId: parentId, limit: RELATED_LIMIT }),
  ]);

  const parent: RelatedRun | undefined =
    parentId === undefined
      ? undefined
      : parentState === null || parentState === undefined
        ? { id: parentId, type: undefined, status: undefined, createdAt: undefined }
        : summarized(parentState);

  const siblingRuns = (siblingPage?.items ?? []).filter((sibling) => sibling.id !== runId);
  // The run is one of its parent's children, listed or not: a parent with more children than the
  // page holds can leave it off the page, and the total still counts it.
  return {
    parent,
    children: { runs: childPage.items.map(summarized), total: childPage.total },
    siblings: {
      runs: siblingRuns.map(summarized),
      total: Math.max(0, (siblingPage?.total ?? 0) - 1),
    },
  };
}
