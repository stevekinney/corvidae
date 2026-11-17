/**
 * COR-2167 — which process runs the listener of a workflow file whose contributed trigger has a
 * `start`, when several Bureaus share one store.
 *
 * Each such file holds the record `bureau-trigger:v1:<workflow-id>` = `{ "processId": <id> }`,
 * naming the process that runs its listener. The record has no expiry of its own: it is live while
 * the named process's own lease (`bureau-process:v1:<id>`, see `process-lease.ts`) is live. A
 * process takes the record before it calls `start`, and only when it is absent or names a process
 * whose lease is absent or expired; anything else, including a record or a lease it cannot read,
 * leaves the listener in `standby`. A takeover is one compare-and-swap on two values as they were
 * read, the record and the named process's lease, so a renewal or another taker that lands in
 * between defeats it (the precedent is the abandoned-task settlement in `task-registry.ts`). A
 * holder removes the record, by compare-and-swap on its own value, when its listener stops.
 *
 * A Bureau whose store dies with its process (memory storage, or none) holds no process lease, and
 * gets no trigger lease: every listener runs, and no record is read or written.
 *
 * What this does not do: a fire that passed the old holder's fence and a fire of the new holder can
 * both start a run for one idempotency key in the window of a handover (see `fireTrigger` in
 * `workflow-runtime.ts`). And it fences fires, not a plugin's own trigger storage: a holder in
 * another process that stalled or was cut off, and was taken over, keeps its listener running until
 * its next tick or fence finds the record no longer names it, and can write that storage until
 * then.
 *
 * @module workflow-trigger-lease
 */

import type { ConditionalTextValueStore } from '@lostgradient/storage';

import { type ProcessLease, processLeaseKey, readProcessLease } from './process-lease';

/** Where the records live. */
const TRIGGER_LEASE_PREFIX = 'bureau-trigger:v1:';

/** The key of the record of workflow `workflowId`. */
export function triggerLeaseKey(workflowId: string): string {
  return `${TRIGGER_LEASE_PREFIX}${workflowId}`;
}

/** What an attempt to take the record found: this process holds it now, or it does not. */
export type TriggerLeaseAcquisition = 'held' | 'standby';

/** The lease of the listeners of one process. */
export interface WorkflowTriggerLease {
  /**
   * Take the record of `workflowId` for this process, if it may: `held` when the record names this
   * process once the call is over, `standby` otherwise. Rejects when the store does; a
   * compare-and-swap that rejected may still have committed.
   */
  acquire(workflowId: string): Promise<TriggerLeaseAcquisition>;
  /** Whether the record of `workflowId` names this process. Rejects when the store does. */
  holds(workflowId: string): Promise<boolean>;
  /**
   * Remove the record of `workflowId` if it still holds this process's own value; one that names
   * another process is left as it is. Never rejects: a failure is diagnosed, and the record stays
   * until this process's lease lapses.
   */
  release(workflowId: string): Promise<void>;
  /** Calls `listener` at each renewal of this process's lease; returns its unsubscribe. */
  onTick(listener: () => void): () => void;
}

/** What {@link createWorkflowTriggerLease} needs. */
export interface CreateWorkflowTriggerLeaseOptions {
  /** The Bureau's key-value store, or `undefined` for a Bureau with no storage. */
  readonly kv: ConditionalTextValueStore | undefined;
  /** This process's lease: its id names the holder, and its renewals are the ticks. */
  readonly processLease: ProcessLease;
  /** The runtime's clock, in epoch milliseconds, which a process lease's expiry is judged by. */
  readonly now: () => number;
  readonly diagnose: (message: string, cause: unknown) => void;
}

/**
 * The process a record names, or `undefined` for a value that is not a record: not JSON, or with no
 * string `processId`.
 */
function holderOf(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'processId')) {
    return undefined;
  }
  const processId = (parsed as { readonly processId: unknown }).processId;
  return typeof processId === 'string' && processId !== '' ? processId : undefined;
}

/**
 * The trigger lease of a process, or `undefined` when there is nothing to coordinate: no store, or
 * a process lease that holds nothing (memory storage), so every listener runs.
 */
export function createWorkflowTriggerLease(
  options: CreateWorkflowTriggerLeaseOptions,
): WorkflowTriggerLease | undefined {
  const { kv, processLease, now, diagnose } = options;
  const processId = processLease.processId;
  if (kv === undefined || processId === undefined) return undefined;
  const own = JSON.stringify({ processId });
  /**
   * The value last diagnosed as unreadable for each workflow, so a value that stays is diagnosed
   * once, not at every tick.
   */
  const diagnosedUnreadable = new Map<string, string>();

  const unreadable = (workflowId: string, value: string, message: string): void => {
    if (diagnosedUnreadable.get(workflowId) === value) return;
    diagnosedUnreadable.set(workflowId, value);
    diagnose(message, undefined);
  };

  return {
    async acquire(workflowId) {
      const key = triggerLeaseKey(workflowId);
      const raw = await kv.get(key);
      if (raw === null) {
        diagnosedUnreadable.delete(workflowId);
        const taken = await kv.conditionalBatch(
          [{ key, expectedValue: null }],
          [{ type: 'set', key, value: own }],
        );
        return taken ? 'held' : 'standby';
      }
      const holder = holderOf(raw);
      if (holder === undefined) {
        unreadable(
          workflowId,
          `record:${raw}`,
          `The listener lease of workflow "${workflowId}" is not readable, so its trigger is left to no process here until the record changes.`,
        );
        return 'standby';
      }
      if (holder === processId) return 'held';
      const reading = await readProcessLease(kv, holder, now());
      if (reading.state === 'live') return 'standby';
      if (reading.state === 'unreadable') {
        unreadable(
          workflowId,
          `lease:${reading.raw}`,
          `The lease of the process that holds the listener of workflow "${workflowId}" is not readable, so its trigger is left to that process.`,
        );
        return 'standby';
      }
      diagnosedUnreadable.delete(workflowId);
      // The holder is gone: its lease was released, reclaimed, or lapsed. The takeover holds only
      // if neither value moved since it was read, so a holder that renewed first keeps the record.
      const taken = await kv.conditionalBatch(
        [
          { key, expectedValue: raw },
          { key: processLeaseKey(holder), expectedValue: reading.raw },
        ],
        [{ type: 'set', key, value: own }],
      );
      return taken ? 'held' : 'standby';
    },

    async holds(workflowId) {
      const raw = await kv.get(triggerLeaseKey(workflowId));
      return raw !== null && holderOf(raw) === processId;
    },

    async release(workflowId) {
      const key = triggerLeaseKey(workflowId);
      try {
        await kv.conditionalBatch([{ key, expectedValue: own }], [{ type: 'delete', key }]);
      } catch (error) {
        diagnose(
          `Could not remove the listener lease of workflow "${workflowId}"; it stays until this process's lease lapses.`,
          error,
        );
      }
    },

    onTick: (listener) => processLease.onRenewed(listener),
  };
}
