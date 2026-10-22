/**
 * The ordinal of a park, derived in one place (COR-1577).
 *
 * A park's review id is `human-wait:<runId>:<signalName>:<parkOrdinal>`, and the ordinal must come
 * out the same wherever it is derived: from the live action log of a run in this process, from
 * the durable checkpoint of a run a restart recovered, and for a catalog run as well as a session
 * run. How many parks a step holds is Operative's rule (`countHumanWaitParks`); this module only
 * walks a run's steps and actions with it.
 *
 * @module park-ordinals
 */

import {
  countHumanWaitParks,
  HumanWaitParkedEvent,
  parkedHumanWait,
} from '@lostgradient/operative';

/** The part of a checkpoint step this module reads. */
export type CheckpointStep = {
  readonly results: ReadonlyArray<{ readonly toolName: string; readonly result: unknown }>;
};

/** What a run's committed checkpoint says about its parks. */
export type CheckpointParks = {
  /** Every park committed so far; the ordinal the next live park takes. */
  readonly baseline: number;
  /**
   * The park the last committed step ended on, if it did, with the ordinal its review id
   * carries: the parks committed before that step.
   */
  readonly outstanding?: {
    readonly signalName: string;
    readonly prompt: string | undefined;
    readonly ordinal: number;
  };
};

/**
 * Read a run's parks from its checkpoint steps. Only the LAST step can hold an unconsumed park:
 * a run that resumed past one has since committed another step. How many parks a step holds is
 * Operative's rule (`countHumanWaitParks`), the one the AG-UI mount names an answer's row by.
 */
export function countCheckpointParks(steps: readonly CheckpointStep[]): CheckpointParks {
  const lastStep = steps[steps.length - 1];
  if (lastStep === undefined) return { baseline: 0 };
  let priorParks = 0;
  for (const step of steps) {
    if (step === lastStep) break;
    priorParks += countHumanWaitParks(step.results);
  }
  const baseline = priorParks + countHumanWaitParks(lastStep.results);
  for (const result of lastStep.results) {
    const park = parkedHumanWait(result);
    if (park === undefined) continue;
    return {
      baseline,
      outstanding: { signalName: park.signalName, prompt: park.prompt, ordinal: priorParks },
    };
  }
  return { baseline };
}

/** An action as the run store records it. */
export type ParkAction = { readonly type: string; readonly detail: unknown };

/**
 * The 0-based ordinal of the LAST distinct park in a run's action log. The park event can be
 * recorded more than once for one park (the tool's execute, the workflow's replay-aware marker,
 * the reconstruction from a checkpoint), so consecutive events on the same signal with no
 * `step.started` between them count once: a genuine re-park always happens in a later step. A
 * reconstructed park carries its durable ordinal in `detail.parkOrdinal`; otherwise the count
 * continues from `baseline`, the parks the checkpoint already committed.
 */
export function humanWaitParkOrdinal(actions: readonly ParkAction[], baseline: number): number {
  let ordinal = baseline - 1;
  let previous: { index: number; signalName: unknown } | undefined;
  actions.forEach((action, index) => {
    if (action.type !== HumanWaitParkedEvent.type) return;
    const detail =
      action.detail !== null && typeof action.detail === 'object'
        ? (action.detail as Record<string, unknown>)
        : undefined;
    const seeded = detail?.['parkOrdinal'];
    const signalName = detail?.['signalName'];
    if (typeof seeded === 'number') {
      ordinal = seeded;
    } else if (
      previous !== undefined &&
      previous.signalName === signalName &&
      !actions.slice(previous.index + 1, index).some((entry) => entry.type === 'step.started')
    ) {
      // Duplicate record of the same park: same ordinal.
    } else {
      ordinal += 1;
    }
    previous = { index, signalName };
  });
  return ordinal;
}
