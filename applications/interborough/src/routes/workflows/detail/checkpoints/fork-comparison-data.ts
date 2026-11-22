/**
 * Data access for a fork's comparison with its source and for a fork's dry run (COR-2538).
 *
 * Both are answered by the server, so every client reads the one alignment and the one preview:
 * `weft.workflows.compare` aligns the fork's timeline with its source's by durable step and
 * `weft.workflows.fork` with `dryRun: true` says what a fork would keep and run again. This module
 * only asks, follows the comparison's pages, and narrows the fork operation's two answers; it
 * aligns nothing, and it replaced the browser-side alignment `divergence.ts` made.
 *
 * Both operations have REST bindings, so `client.operations[...]` reaches them over REST and a fault
 * keeps its fine-grained `weftCode` (`WorkflowRevisionUnavailableError` for an uninstalled revision).
 */
import type { HttpClient } from '@lostgradient/weft';
import type { QueryKey } from '@tanstack/svelte-query';

/** The one read the comparison needs off `client.operations`. */
export interface ForkComparisonClient {
  readonly operations: Pick<HttpClient['operations'], 'weft.workflows.compare'>;
}

/** The one call the fork dialog's dry run needs off `client.operations`. */
export interface ForkPreviewClient {
  readonly operations: Pick<HttpClient['operations'], 'weft.workflows.fork'>;
}

/** A page of the comparison, as the server answers it. */
type ForkComparisonPage = Awaited<
  ReturnType<ForkComparisonClient['operations']['weft.workflows.compare']>
>;

/** A fork's whole comparison with its source: every page of it, joined. */
export type ForkComparisonResult = Omit<ForkComparisonPage, 'nextCursor'>;

/** What forking would do, as the server's dry run answers it. */
export type ForkPreviewResult = Extract<
  Awaited<ReturnType<ForkPreviewClient['operations']['weft.workflows.fork']>>,
  { readonly dryRun: true }
>;

/** The steps a page holds when the comparison asks for the most the server allows. */
const COMPARISON_PAGE_SIZE = 1000;

export function forkComparisonQueryKey(forkWorkflowId: string): QueryKey {
  return ['workflows', 'fork-comparison', forkWorkflowId];
}

/**
 * The comparison of `forkWorkflowId` with its source, every step of it: the server pages by step, so
 * this follows `nextCursor` until the last page and returns one answer, never the first page alone.
 */
export async function fetchForkComparison(
  client: ForkComparisonClient,
  forkWorkflowId: string,
): Promise<ForkComparisonResult> {
  const compare = client.operations['weft.workflows.compare'];
  const first = await compare({ workflowId: forkWorkflowId, limit: COMPARISON_PAGE_SIZE });
  const steps = [...first.steps];
  let cursor = first.nextCursor;
  while (cursor !== undefined) {
    const page = await compare({
      workflowId: forkWorkflowId,
      limit: COMPARISON_PAGE_SIZE,
      cursor,
    });
    steps.push(...page.steps);
    cursor = page.nextCursor;
  }
  return {
    workflowId: first.workflowId,
    sourceWorkflowId: first.sourceWorkflowId,
    forkPoint: first.forkPoint,
    steps,
  };
}

/** What the fork dialog chose: the step to fork from and, when it picked one, the revision. */
export interface ForkPreviewRequest {
  readonly fromStep: number;
  readonly revision?: string | undefined;
}

export function forkPreviewQueryKey(workflowId: string, request: ForkPreviewRequest): QueryKey {
  return ['workflows', 'fork-preview', workflowId, request.fromStep, request.revision ?? null];
}

/**
 * What forking `workflowId` with `request` would do, from the server's dry run. The fork operation
 * answers a preview or a created fork's id; a dry run is always the first, so the second is a server
 * that did not honor `dryRun` and is refused here rather than read as a preview.
 */
export async function fetchForkPreview(
  client: ForkPreviewClient,
  workflowId: string,
  request: ForkPreviewRequest,
): Promise<ForkPreviewResult> {
  const answer = await client.operations['weft.workflows.fork']({
    workflowId,
    fromStep: request.fromStep,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    dryRun: true,
  });
  if (!('dryRun' in answer)) {
    throw new TypeError('weft.workflows.fork did not answer the dry run with a preview');
  }
  return answer;
}
