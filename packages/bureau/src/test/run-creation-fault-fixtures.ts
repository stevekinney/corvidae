/**
 * COR-424, COR-1795 — what the run-creation fault-point test (`run-creation-fault-points.test.ts`)
 * and its crash child (`run-creation-crash-child.ts`) share: the request both Bureaus receive, the
 * scenarios the child can play, and the marker it leaves behind before it dies.
 */
import type { TaskHandle } from '../types';
import type { TaskStartRequest } from './task-start-request.ts';

/** The client request Bureau A is interrupted on and Bureau B receives as the retry. */
export const REQUEST: TaskStartRequest = {
  agentName: 'default',
  input: 'Reconcile the ledger.',
  principal: 'alice',
  commandId: 'request-1',
};

/** The fault points the crash child can die at, one scenario each. */
export const FAULT_SCENARIOS = [
  'crash-before-claim',
  'after-claim',
  'after-work-start',
  'after-prepare-before-launch',
  'after-effect-before-ack',
  'during-cancellation',
] as const;

/** One of {@link FAULT_SCENARIOS}. */
export type FaultScenario = (typeof FAULT_SCENARIOS)[number];

/**
 * What the crash child records, synchronously, immediately before it kills itself: whatever its
 * Bureau observed that the parent can no longer read through a live Bureau A.
 */
export interface FaultMarker {
  /** The run ids Bureau A listed through `tasks.workflows()` after its crash point. */
  readonly runIds?: readonly string[] | undefined;
  /** The run Bureau A's caller was handed (`after-effect-before-ack`, `during-cancellation`). */
  readonly started?: { readonly id: string; readonly receipt: TaskHandle['receipt'] };
  /** The messages of every diagnostic Bureau A reported before it died. */
  readonly diagnostics: readonly string[];
}
