/**
 * Keeps task evidence current when the fleet feed reports a task's result
 * changing (COR-284). A dead-lettered result changes the task's ledger record,
 * the Diagnostics report (and with it the Dashboard's critical-alerts band),
 * and the task's delivery history; a `task:result-delivery` event, which the
 * server emits for a duplicate or rejected delivery, changes the delivery
 * history and, when the server dead-lettered the result, the ledger record.
 *
 * A first-time `applied` result is represented by the live
 * `activity:completed` event; duplicate and rejected deliveries remain covered
 * by `task:result-delivery`.
 * Nothing here opens a connection: the shell's one shared fleet subscription
 * calls it.
 *
 * @module
 */
import type { QueryClient } from '@tanstack/svelte-query';

import type { FleetEventFrame } from '../lib/live-source/fleet-event-source.svelte.ts';
import { queryKeys } from '../lib/query.ts';

function operationIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value: unknown = Reflect.get(payload, 'operationId');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Task events whose arrival invalidates cached task evidence. */
export const TASK_EVIDENCE_EVENT_KINDS: ReadonlySet<string> = new Set([
  'task:dead-lettered',
  'task:result-delivery',
  'activity:completed',
]);

/**
 * Activity events that move a task's ledger record without settling its result: an attempt starts,
 * fails, waits on an external completion, is queued for a worker, or is asked to stop. They stand in
 * for `task:attempt-transition`, which the fleet feed does not carry (its payload holds execution
 * identity, so it is on the deny-list, `client-visible-events.ts`), and each names the task by
 * `operationId`. Only the task's own record is read again.
 */
export const TASK_LIFECYCLE_EVENT_KINDS: ReadonlySet<string> = new Set([
  'activity:started',
  'activity:failed',
  'activity:async-pending',
  'activity:remote-queued',
  'activity:remote-cancellation-requested',
]);

/**
 * Invalidates the queries a task event makes stale. Returns whether the frame
 * was a task evidence event, so a caller can tell a handled frame from one it
 * should leave alone.
 */
export function invalidateForTaskEvent(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  frame: FleetEventFrame,
): boolean {
  const operationId = operationIdOf(frame.payload);
  if (TASK_LIFECYCLE_EVENT_KINDS.has(frame.kind)) {
    if (operationId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(operationId) });
    }
    return true;
  }
  if (!TASK_EVIDENCE_EVENT_KINDS.has(frame.kind)) return false;
  if (operationId !== undefined) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(operationId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.deliveries(operationId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.deadLetter(operationId) });
  }
  if (frame.kind === 'task:dead-lettered') {
    // Prefix match: the unfiltered report, every provenance-filtered one, and
    // the Dashboard's critical-alerts band all read `['diagnostics', …]`.
    void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics() });
  }
  return true;
}

/**
 * Subscribes task evidence invalidation to a fleet source and returns the
 * unsubscribe. The shell calls it once, with its one shared source.
 */
export function subscribeTaskEvidenceInvalidation(
  source: { subscribe(listener: (frame: FleetEventFrame) => void): () => void },
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
): () => void {
  return source.subscribe((frame) => void invalidateForTaskEvent(queryClient, frame));
}
