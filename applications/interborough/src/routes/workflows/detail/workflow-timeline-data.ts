/**
 * Generated timeline read and derivations over its entries for the
 * Signals tab (plan T2.6).
 *
 * ## Why the timeline, not `getEvents()`
 *
 * Verified empirically against a live dev-harness workflow (start a
 * `signal-stepped` fixture run, send it a signal, diff `GET
 * …/events` before/after): the durable per-workflow event log
 * (`engine.getEvents()`, weft v0.11.0 `src/core/engine/checkpoint-reads.ts`)
 * records only `workflow:checkpoint` markers (`{ step }`) — no
 * `signal:received`/`update:received` entries ever appear there, regardless
 * of what `EVENTS_READ_EVENT_TYPES` documents for the live fleet/tail
 * channels. `GET …/timeline` (`engine.getTimeline()`), by contrast, records
 * one rich entry per durable operation — `operationType: 'wait-signal'`
 * with `operationLabel` as the signal name — confirmed against the same
 * live workflow. This module reads that instead. (The Timeline *tab*'s own
 * UI, T3.1, is a different track; this module only calls the same
 * same read the Timeline tab also calls — no
 * coupling to its component.)
 *
 * ## Children moved off the timeline entirely (weft#732 item 1, shipped 0.15.0)
 *
 * This module used to also export `childWorkflowsFromTimeline`, deriving
 * Children-tab/Lineage-panel rows from `operationType: 'child-workflow'`
 * timeline entries — `WorkflowTimelineEntry.outputSummary` could never
 * reliably recover a real child workflow id (an AWAITED child's
 * `outputSummary` is its own arbitrary business result, indistinguishable
 * from a DETACHED child's `{"id":"..."}` result), so every row rendered
 * with `workflowId: null` and no working link. `WorkflowState.
 * parentWorkflowId` + `ListFilter.parentWorkflowId` are now public
 * (weft#732 item 1), so the run page's Related runs (`runs/run-related-data.ts`)
 * query `client.list({ parentWorkflowId })` directly instead — real ids,
 * real links, no timeline coupling.
 */
import {
  HttpClientError,
  type HttpClient,
  type WorkflowTimelineEntry,
  type WorkflowTimelineOperationDetail,
  type WorkflowTimelineStatus,
} from '@lostgradient/weft';
import type { QueryKey } from '@tanstack/svelte-query';

type TimelineEntry = Awaited<
  ReturnType<HttpClient['operations']['weft.workflows.timeline.get']>
>[number];
type TimelineBranch = NonNullable<TimelineEntry['branches']>[number];

function mutableBranch(branch: TimelineBranch): WorkflowTimelineOperationDetail {
  const { branches, ...fields } = branch;
  return {
    ...fields,
    ...(branches === undefined ? {} : { branches: branches.map(mutableBranch) }),
  };
}

function mutableVersion(
  version: NonNullable<TimelineEntry['versionTuple']>,
): NonNullable<WorkflowTimelineEntry['versionTuple']> {
  const { toolVersions, ...fields } = version;
  return { ...fields, ...(toolVersions === undefined ? {} : { toolVersions: [...toolVersions] }) };
}

/** Reads the generated timeline while preserving the ergonomic client's missing-run behavior. */
export async function fetchWorkflowTimeline(
  client: { readonly operations: Pick<HttpClient['operations'], 'weft.workflows.timeline.get'> },
  workflowId: string,
): Promise<WorkflowTimelineEntry[]> {
  try {
    const entries = await client.operations['weft.workflows.timeline.get']({ workflowId });
    return entries.map(({ branches, children, versionTuple, ...fields }) => ({
      ...fields,
      ...(branches === undefined ? {} : { branches: branches.map(mutableBranch) }),
      ...(children === undefined ? {} : { children: children.map(mutableBranch) }),
      ...(versionTuple === undefined ? {} : { versionTuple: mutableVersion(versionTuple) }),
    }));
  } catch (error) {
    if (error instanceof HttpClientError && error.status === 404) return [];
    throw error;
  }
}

/** Shared `getTimeline(id)` query key — used by the Signals tab (history), the Timeline tab, and the Events tab's linked selection, so all readers share the same TanStack Query cache entry instead of drifting into separately-keyed duplicate fetches. */
export function workflowTimelineQueryKey(workflowId: string): QueryKey {
  return ['workflows', 'timeline', workflowId];
}

export interface SignalTimelineRow {
  readonly step: number;
  readonly name: string;
  readonly status: WorkflowTimelineStatus;
  readonly timestamp: number;
}

/** Signals delivered to a `ctx.waitForSignal()` wait point, oldest first. Signals sent while the workflow was not yet waiting for them are not visible here — see module doc. */
export function signalHistoryFromTimeline(
  entries: readonly WorkflowTimelineEntry[],
): SignalTimelineRow[] {
  return entries
    .filter((entry) => entry.operationType === 'wait-signal')
    .map((entry) => ({
      step: entry.step,
      name: entry.operationLabel,
      status: entry.status,
      timestamp: entry.timestamp,
    }));
}
