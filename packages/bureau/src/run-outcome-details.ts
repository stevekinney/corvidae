/**
 * What a live `RunErrorEvent` knew about a failed run that its settlement does not keep.
 *
 * A run's task settles from the run's terminal action, whose error the store serializes to text
 * (`serialization.ts`), so by the time the task registry announces the settlement the failing step,
 * `AgentRunError.code` and `AgentRunError.kind` are gone. Each run's event feed sees the
 * `RunErrorEvent` first, so it leaves them here, keyed by run, and the settlement announcement
 * takes them: one entry is written by the run's feed and read, once, by `run.error`.
 *
 * An entry that is never taken (a settlement write that fails, or a shutdown before the settlement
 * is written) is dropped when the Bureau is disposed, and, for a run on the run store, when the
 * store removes the run. A child run, a goal attempt or a workflow step is not on the store, so its
 * untaken entry stays until dispose: at most one small entry for each such run whose settlement
 * never landed.
 *
 * @module run-outcome-details
 */

import type { RunFailureDetail } from './events.ts';
import { publishableErrorCode, publishableErrorKind } from './published-error-names.ts';

/** The code `AgentRunError` itself falls back to, published for a failure whose own code is not an identifier. */
const FALLBACK_ERROR_CODE = 'UNKNOWN';

/** The part of a `RunErrorEvent` the details keep. */
export interface RunErrorObservation {
  readonly step: number;
  readonly error: { readonly code: string; readonly kind: string };
  /** Present, and `true`, when `step` is a count of recorded steps rather than the failing one. */
  readonly reconstructed?: true | undefined;
}

/** The writer's half of {@link RunOutcomeDetails}, which a run's feed holds. */
export interface RunOutcomeDetailRecorder {
  /** Records what a run's `RunErrorEvent` said, replacing an earlier entry for the run. */
  record(runId: string, event: RunErrorObservation): void;
}

/** The failures a Bureau's runs have announced and its task registry has not yet. */
export interface RunOutcomeDetails extends RunOutcomeDetailRecorder {
  /** The entry for `runId`, removed, or `undefined` when no live `RunErrorEvent` left one. */
  take(runId: string): RunFailureDetail | undefined;
  /** Drops the entry for `runId`, if any. */
  forget(runId: string): void;
  /** Drops every entry. */
  clear(): void;
  /** How many entries are held. */
  size(): number;
}

/** An empty set of details. */
export function createRunOutcomeDetails(): RunOutcomeDetails {
  const entries = new Map<string, RunFailureDetail>();
  return {
    record(runId, event) {
      // Shape-checked where the entry is made, so free text set as a code or a kind never reaches
      // an event (COR-2095, Revision 2026-11-16).
      const errorKind = publishableErrorKind(event.error.kind);
      entries.set(runId, {
        // A reconstructed step is a guess (the count of recorded steps), so it is left out.
        ...(event.reconstructed === true ? {} : { step: event.step }),
        errorCode: publishableErrorCode(event.error.code, FALLBACK_ERROR_CODE),
        ...(errorKind === undefined ? {} : { errorKind }),
      });
    },
    take(runId) {
      const entry = entries.get(runId);
      entries.delete(runId);
      return entry;
    },
    forget(runId) {
      entries.delete(runId);
    },
    clear() {
      entries.clear();
    },
    size: () => entries.size,
  };
}
