/**
 * What a live run's events knew about its failure that its settlement does not keep.
 *
 * A run's task settles from the run's terminal action, whose error the store serializes to text
 * (`serialization.ts`), so by the time the task registry announces the settlement the failing step,
 * `AgentRunError.code` and `AgentRunError.kind` are gone, and a failed tool call is named nowhere.
 * Each run's event feed sees the `RunErrorEvent` first, and the `tool.settled` that preceded it, so
 * it leaves what they said here, keyed by run, and two readers take it: the settlement write reads
 * it without removing it (`peek`) and stores it on the task record (COR-2531), and the settlement
 * announcement takes it, once, for `run.error`.
 *
 * An entry that is never taken (a settlement write that fails, or a shutdown before the settlement
 * is written) is dropped when the Bureau is disposed, and, for a run on the run store, when the
 * store removes the run. A child run, a goal attempt or a workflow step is not on the store, so its
 * untaken entry stays until dispose: at most one small entry for each such run whose settlement
 * never landed.
 *
 * The same listeners report a model step on its second or later try (`generate.retry`), which the
 * Bureau writes to the task record so a process that does not hold the run can read it.
 *
 * @module run-outcome-details
 */

import type { ActiveRun } from '@lostgradient/operative';

import type { RunFailureDetail } from './events.ts';
import { publishableErrorCode, publishableErrorKind } from './published-error-names.ts';
import {
  truncateFailureText,
  type TaskFailure,
  type TaskFailureToolCall,
  type TaskRetrying,
} from './task-failure.ts';

/** The code `AgentRunError` itself falls back to, published for a failure whose own code is not an identifier. */
const FALLBACK_ERROR_CODE = 'UNKNOWN';

/** The label of a model step: the step a retry or a failure names when no tool call is involved. */
const MODEL_STEP_LABEL = 'model';

/** The error kinds whose failing step is the model's: a provider failure, and a response that is not valid output. */
const MODEL_STEP_ERROR_KINDS: ReadonlySet<string> = new Set(['generate', 'output']);

/** The part of a `RunErrorEvent` the details keep. */
export interface RunErrorObservation {
  readonly step: number;
  readonly error: { readonly code: string; readonly kind: string };
  /** Present, and `true`, when `step` is a count of recorded steps rather than the failing one. */
  readonly reconstructed?: true | undefined;
  /**
   * The tool call that failed in `step`, when one was seen settling in error: its name and its
   * identifier. Never its arguments.
   */
  readonly toolCall?: TaskFailureToolCall | undefined;
}

/** What a failed run's events left: the {@link RunFailureDetail} `run.error` publishes, and the step and call a task records. */
interface RunFailureObservation extends RunFailureDetail {
  /** The failing step's label: the failed tool's name, or `model`; left out when no step or call is known. */
  readonly stepLabel?: string | undefined;
  /** The tool call that failed. */
  readonly toolCall?: TaskFailureToolCall | undefined;
}

/** The writer's half of {@link RunOutcomeDetails}, which a run's feed holds. */
export interface RunOutcomeDetailRecorder {
  /** Records what a run's `RunErrorEvent` said, replacing an earlier entry for the run. */
  record(runId: string, event: RunErrorObservation): void;
  /**
   * Records the step a run is on a second or later try of, or that none is (`null`): the Bureau
   * writes it to the run's task.
   */
  recordRetrying(runId: string, retrying: TaskRetrying | null): void;
}

/** The failures a Bureau's runs have announced and its task registry has not yet. */
export interface RunOutcomeDetails extends RunOutcomeDetailRecorder {
  /** The entry for `runId`, removed, or `undefined` when no live `RunErrorEvent` left one. */
  take(runId: string): RunFailureObservation | undefined;
  /** The entry for `runId`, left in place, or `undefined` when no live `RunErrorEvent` left one. */
  peek(runId: string): RunFailureObservation | undefined;
  /** Drops the entry for `runId`, if any. */
  forget(runId: string): void;
  /** Drops every entry. */
  clear(): void;
  /** How many entries are held. */
  size(): number;
}

/** What {@link createRunOutcomeDetails} reports to. */
export interface RunOutcomeDetailsOptions {
  /** Receives each change of the step a run is retrying; it must not throw into the run. */
  readonly onRetrying?: ((runId: string, retrying: TaskRetrying | null) => void) | undefined;
}

/** An empty set of details. */
export function createRunOutcomeDetails(options: RunOutcomeDetailsOptions = {}): RunOutcomeDetails {
  const entries = new Map<string, RunFailureObservation>();
  return {
    record(runId, event) {
      // Shape-checked where the entry is made, so free text set as a code or a kind never reaches
      // an event (COR-2095, Revision 2026-11-16).
      const errorKind = publishableErrorKind(event.error.kind);
      const toolCall =
        event.toolCall === undefined
          ? undefined
          : {
              name: truncateFailureText(event.toolCall.name),
              callId: truncateFailureText(event.toolCall.callId),
            };
      // A reconstructed step is a guess (the count of recorded steps), so it and its label are left out.
      const reconstructed = event.reconstructed === true;
      const stepLabel = reconstructed
        ? undefined
        : (toolCall?.name ??
          (errorKind !== undefined && MODEL_STEP_ERROR_KINDS.has(errorKind)
            ? MODEL_STEP_LABEL
            : undefined));
      entries.set(runId, {
        ...(reconstructed ? {} : { step: event.step }),
        errorCode: publishableErrorCode(event.error.code, FALLBACK_ERROR_CODE),
        ...(errorKind === undefined ? {} : { errorKind }),
        ...(stepLabel === undefined ? {} : { stepLabel }),
        ...(toolCall === undefined ? {} : { toolCall }),
      });
    },
    recordRetrying(runId, retrying) {
      options.onRetrying?.(runId, retrying);
    },
    take(runId) {
      const entry = entries.get(runId);
      entries.delete(runId);
      return entry;
    },
    peek: (runId) => entries.get(runId),
    forget(runId) {
      entries.delete(runId);
    },
    clear() {
      entries.clear();
    },
    size: () => entries.size,
  };
}

/**
 * The failure a task records for what a run's events left (COR-2531): the failing step (its index
 * and label, when both are known), the error's code and kind, and the tool call. Never an
 * argument or any error text.
 */
function taskFailureOf(observation: RunFailureObservation): TaskFailure {
  return {
    ...(observation.step === undefined || observation.stepLabel === undefined
      ? {}
      : { step: { index: observation.step, label: observation.stepLabel } }),
    ...(observation.errorCode === undefined ? {} : { errorCode: observation.errorCode }),
    ...(observation.errorKind === undefined ? {} : { errorKind: observation.errorKind }),
    ...(observation.toolCall === undefined
      ? {}
      : { toolCall: { name: observation.toolCall.name, callId: observation.toolCall.callId } }),
  };
}

/**
 * The failure `runId`'s own events left, as a task records it, or `undefined` when none did. The
 * entry is left in place: the settlement's announcement takes it afterwards.
 */
export function peekTaskFailure(
  details: Pick<RunOutcomeDetails, 'peek'>,
  runId: string,
): TaskFailure | undefined {
  const observation = details.peek(runId);
  return observation === undefined ? undefined : taskFailureOf(observation);
}

/** `error` and the errors it carries as `cause`, outermost first, as far as they are objects. */
function causeChainOf(error: unknown): object[] {
  const chain: object[] = [];
  let current: unknown = error;
  // Bounded: a cycle of causes must not hold the run's own dispatch.
  while (typeof current === 'object' && current !== null && chain.length < 8) {
    if (chain.includes(current)) break;
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** The event types {@link observeRunOutcome} listens for. */
type ObservedEventType =
  | 'tool.settled'
  | 'run.error'
  | 'generate.retry'
  | 'generate.started'
  | 'generate.completed'
  | 'generate.error';

/** The run, as far as {@link observeRunOutcome} reads it. */
export type ObservedRun = Pick<ActiveRun, 'addEventListener' | 'removeEventListener'>;

/**
 * Listens to a run for what its failure and its retries will need (COR-2095, COR-2531): the
 * `tool.settled` events that name a failed call, the `run.error` that ends the run (recorded with
 * the call that failed in its step), and the `generate.retry` that marks a model step on its second
 * or later try, cleared when the model step settles. Returns a disposer.
 *
 * Each listener is guarded: it sits on the run's own emitter, and a throw escaping it would surface
 * inside whichever dispatch the run was making, its terminal one included. Nothing is read from an
 * event but the identifiers: a tool's arguments and error text are never kept.
 */
export function observeRunOutcome(
  activeRun: ObservedRun,
  runId: string,
  recorder: RunOutcomeDetailRecorder,
  onError?: (error: unknown, kind: string) => void,
): () => void {
  const disposers: Array<() => void> = [];
  const listen = (
    type: ObservedEventType,
    handler: (event: Record<string, unknown>) => void,
  ): void => {
    const listener = (event: Event): void => {
      try {
        handler(event as unknown as Record<string, unknown>);
      } catch (error) {
        onError?.(error, type);
      }
    };
    activeRun.addEventListener(type, listener);
    disposers.push(() => activeRun.removeEventListener(type, listener));
  };

  // The calls that settled in error in the latest step that had one, each with the error it settled
  // with. A call that fails recoverably does not end the run (the default `collect` mode hands its
  // error back to the model), so a terminal error of the same step can come from another cause
  // altogether, such as a guardrail on a later call's result. The run's own error names a call only
  // by carrying that call's error, as the cause the toolbox rejected with, so a call is attached to
  // the failure only when its error is the run error or one of its causes, never by step alone.
  let failedCalls: {
    readonly step: unknown;
    readonly calls: Array<{ readonly call: TaskFailureToolCall; readonly error: object }>;
  } = { step: undefined, calls: [] };
  listen('tool.settled', (event) => {
    if (event['status'] !== 'error') return;
    // Another run's call can reach this run's emitter (a delegation's child announces on it): only
    // this run's own are its failure's.
    if (typeof event['runId'] === 'string' && event['runId'] !== runId) return;
    const { toolName, toolCallId, step, error } = event;
    if (typeof toolName !== 'string' || typeof toolCallId !== 'string') return;
    // An error that is not an object cannot be told from another call's, so it names no call.
    if (typeof error !== 'object' || error === null) return;
    if (failedCalls.step !== step) failedCalls = { step, calls: [] };
    failedCalls.calls.push({ call: { name: toolName, callId: toolCallId }, error });
  });
  listen('run.error', (event) => {
    const error = event['error'] as { code: string; kind: string };
    const step = event['step'] as number;
    const failedCall =
      failedCalls.step === step
        ? failedCalls.calls.find(({ error: callError }) => causeChainOf(error).includes(callError))
        : undefined;
    recorder.record(runId, {
      step,
      error,
      ...(event['reconstructed'] === true ? { reconstructed: true as const } : {}),
      ...(failedCall === undefined ? {} : { toolCall: failedCall.call }),
    });
  });

  // A model step's tries add up from two sources: the provider retries inside one `generate`
  // (`generate.retry` names the attempt that failed, so the one now starting is the next), and the
  // `onError` hook's re-runs of the whole step, each of which is another `generate.started` for the
  // same step. A step is retrying from its second try until it produces a response or fails for
  // good (`generate.completed`, `generate.error`), and a different step starting ends it too.
  let startedStep: unknown;
  let recoveries = 0;
  let providerAttempt = 1;
  let retrying = false;
  const clearRetrying = (): void => {
    if (!retrying) return;
    retrying = false;
    recorder.recordRetrying(runId, null);
  };
  const reportTries = (): void => {
    const attempt = recoveries + providerAttempt;
    if (attempt < 2) {
      clearRetrying();
      return;
    }
    retrying = true;
    recorder.recordRetrying(runId, { label: MODEL_STEP_LABEL, attempt });
  };
  listen('generate.started', (event) => {
    const step = event['step'];
    // The same step starting again is a whole-step re-run: every provider call the earlier run of the
    // step made counts as a try, so the count only rises.
    recoveries = step === startedStep ? recoveries + providerAttempt : 0;
    startedStep = step;
    providerAttempt = 1;
    reportTries();
  });
  listen('generate.retry', (event) => {
    const attempt = event['attempt'];
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) return;
    providerAttempt = attempt + 1;
    reportTries();
  });
  listen('generate.completed', clearRetrying);
  listen('generate.error', clearRetrying);

  return () => {
    for (const dispose of disposers) dispose();
  };
}
