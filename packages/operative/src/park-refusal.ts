/**
 * The refusal both park tools return for a second park request in one step (COR-1578).
 *
 * A run step parks on at most one request, because `pendingHumanWait` and `pendingWakeup` are one
 * slot between them. The first request to reach a tool's `execute` in a step is honored; every
 * later one is refused here, as a normal tool result the model reads in its next request, never as
 * a thrown error.
 *
 * @module park-refusal
 */

import { renderDurationLabel } from './durable/continuation-input';
import type { PendingHumanWait, PendingWakeup } from './durable/types';

/**
 * What `requestHumanInput` and `scheduleWakeup` add to their result when the step already holds a
 * park. It is persisted in `StepRecord.results`, so its fields are a durable shape.
 */
export interface RefusedParkRequest {
  /** Always `true`: the request was not honored. */
  refused: true;
  /** The park the step already holds, which this request did not replace. */
  pendingPark:
    | { kind: 'human-input'; signalName: string }
    | { kind: 'wakeup'; duration: PendingWakeup['duration'] };
  /** Human-readable message the LLM can use in its response. */
  message: string;
}

/** The park slots a step's tools write, as a park tool reads them. */
export interface ParkSlots {
  readonly pendingHumanWait: PendingHumanWait | undefined;
  readonly pendingWakeup: PendingWakeup | undefined;
}

/**
 * Refuses a park request when the step already holds a park, or returns `undefined` when the
 * request is the first and may take its slot. The check and the slot write both happen inside a
 * synchronous `execute`, so two calls cannot interleave between them.
 */
export function refuseIfStepIsParked(slots: ParkSlots): RefusedParkRequest | undefined {
  if (slots.pendingHumanWait !== undefined) {
    const { signalName } = slots.pendingHumanWait;
    return {
      refused: true,
      pendingPark: { kind: 'human-input', signalName },
      message: refusalMessage(`human signal "${signalName}"`),
    };
  }
  if (slots.pendingWakeup !== undefined) {
    const { duration } = slots.pendingWakeup;
    return {
      refused: true,
      pendingPark: { kind: 'wakeup', duration },
      message: refusalMessage(`a wakeup in ${renderDurationLabel(duration)}`),
    };
  }
  return undefined;
}

function refusalMessage(pending: string): string {
  return `Not requested: this step already waits for ${pending}. Request it again after that wait ends.`;
}
