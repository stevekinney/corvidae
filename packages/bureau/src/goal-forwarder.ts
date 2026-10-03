/**
 * COR-851 — carries an attempt's ending from its run to its goal's controller.
 *
 * The controller waits for a signal named `attempt-terminal:<n>`; nothing in
 * the run tells it to send one. This does. It watches the attempt's durable run
 * and, once the run is terminal, reads how it ended from the engine's stored
 * state and checkpoint (never from a live handle, so the payload is the same
 * whichever process reads it) and sends the signal under a stable id.
 *
 * Before sending, it commits the attempt's transcript to the goal's session
 * (`GoalConversations.settle`), so the next attempt and the validator always
 * find it, on the live path and the recovery path alike.
 *
 * A failure while forwarding (a session store or engine hiccup) is retried a
 * few times with backoff before it is diagnosed, since nothing else would send
 * the signal until the next boot.
 *
 * Three things keep a lost forwarder from parking a goal forever:
 *
 * - The signal id is `attempt-terminal:<goalRunId>:<n>`, so sending it twice
 *   delivers it once and `reconcile()` may be called as often as recovery likes.
 * - Weft buffers a signal for a workflow that has not reached its wait, so an
 *   attempt that ends before the controller parks is not lost.
 * - A process that dies with attempts in flight leaves no forwarder behind;
 *   recovery calls `reconcile()` for every goal still waiting, which re-sends
 *   for a run that ended while nobody was watching and re-attaches for one that
 *   is still going.
 *
 * Nothing is sent once the goal is terminal or has a cancellation marker, since
 * the controller no longer waits for it, and nothing is sent once the bureau
 * is closing: a run ended by shutdown is a crash for the next process to
 * recover, never a verdict for the goal.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type AgentRun,
  type DurableActiveRunContext,
  type FinishReason,
  type GoalAttemptTerminalSignal,
  goalAttemptTerminalSignalName,
  readDurableRunResult,
  type RunOptions,
} from '@lostgradient/operative';

import type { GoalConversations } from './goal-conversation';
import { attemptSignalId, goalWorkflowId, isTerminalGoalStatus } from './goal-state';
import type { GoalStore } from './goal-store';
import type { DiagnosticSink } from './types';

export interface AttemptTarget {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly runId: string;
}

export interface AttemptForwarderDependencies {
  readonly store: GoalStore;
  readonly runtime: RuntimeServices;
  readonly getDurable: () => DurableActiveRunContext | undefined;
  /**
   * The cost estimation the attempt's agent was configured with. Asked only for
   * a goal with a cost bound, because only then does a missing estimate change a
   * decision (the attempt cannot be accounted, so it fails).
   */
  readonly resolveCostEstimation: (
    agentName: string,
    prompt: string,
    principal: string | undefined,
  ) => Promise<RunOptions['costEstimation'] | undefined>;
  /** Commits a finished attempt's transcript to its session before the controller is told it ended. */
  readonly conversations: Pick<GoalConversations, 'settle'>;
  readonly isClosing: () => boolean;
  readonly diagnose: DiagnosticSink;
  /**
   * How long to wait before each further try when forwarding an attempt's end
   * fails (a store or engine hiccup); one entry per retry. Defaults to
   * {@link DEFAULT_FORWARD_RETRY_DELAYS_MS}. Once they are spent the failure is
   * diagnosed and recovery is what sends the signal.
   */
  readonly retryDelaysMs?: readonly number[] | undefined;
}

/** Four retries over about eight seconds: long enough to ride out a hiccup, short enough to bound a dispose. */
export const DEFAULT_FORWARD_RETRY_DELAYS_MS: readonly number[] = [100, 400, 1_600, 6_400];

export type AttemptReconciliation =
  /** The run is alive; a watcher is attached. */
  | 'watching'
  /** The run had ended; its signal was sent. */
  | 'signal-resent'
  /** No run exists under this id. */
  | 'missing'
  /** Nothing to send: the goal ended, was canceled, or the bureau is closing. */
  | 'not-needed';

export interface AttemptForwarder {
  /** Idempotent per run id. `live` is the in-process handle of a run this process started. */
  watch(target: AttemptTarget, live?: AgentRun<unknown, boolean>): void;
  reconcile(target: AttemptTarget): Promise<AttemptReconciliation>;
  /** Resolves once every send already under way has finished. It does not wait on a running attempt. */
  drain(): Promise<void>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createAttemptForwarder(
  dependencies: AttemptForwarderDependencies,
): AttemptForwarder {
  const { store, runtime, getDurable, resolveCostEstimation, conversations, isClosing, diagnose } =
    dependencies;
  const retryDelaysMs = dependencies.retryDelaysMs ?? DEFAULT_FORWARD_RETRY_DELAYS_MS;
  const watching = new Map<string, Promise<void>>();
  const sending = new Set<Promise<unknown>>();

  /** Sends the attempt's terminal signal if its run has ended. */
  async function forward(target: AttemptTarget): Promise<AttemptReconciliation> {
    const durable = getDurable();
    if (durable === undefined || isClosing()) return 'not-needed';
    const record = await store.get(target.goalRunId);
    if (
      record === undefined ||
      isTerminalGoalStatus(record.status) ||
      record.cancellation !== undefined
    ) {
      return 'not-needed';
    }
    // A resolver that fails here is not an attempt that has no cost: reading the
    // result without an estimate would be recorded as `costUnaccounted` and end
    // the goal over a fault that may be gone by the next try. The failure
    // propagates, so the forwarder retries it and recovery sends the signal.
    const costEstimation =
      record.bounds.maximumTotalCostUsd === undefined
        ? undefined
        : await resolveCostEstimation(
            record.objective.agentName,
            record.objective.prompt,
            record.principal,
          );
    const reading = await readDurableRunResult(durable, target.runId, { runtime, costEstimation });
    if (reading.status === 'missing') return 'missing';
    if (reading.status === 'not-terminal') return 'watching';
    if (isClosing()) return 'not-needed';
    // Before the controller can start the next attempt or the validator, so a
    // retry always finds this attempt's transcript in the session. Idempotent,
    // so a recovery that sends the signal again commits nothing twice.
    await conversations.settle(record, target.attemptIndex, target.runId);

    const finishReason: FinishReason = reading.result.finishReason;
    const cost = reading.result.costEstimate?.totalCost;
    const payload: GoalAttemptTerminalSignal = {
      finishReason,
      steps: reading.result.steps.length,
      tokens: reading.result.usage.total,
      ...(cost === undefined ? {} : { costUsd: cost }),
    };
    try {
      await durable.engine.signal(
        goalWorkflowId(target.goalRunId),
        goalAttemptTerminalSignalName(target.attemptIndex),
        payload,
        { signalId: attemptSignalId(target.goalRunId, target.attemptIndex) },
      );
    } catch (error) {
      // A controller that ended while the signal was on its way has nothing
      // left to wait for, so that is not a failure to report.
      if (await controllerIsDone(target.goalRunId)) return 'not-needed';
      throw error;
    }
    return 'signal-resent';
  }

  /** The goal ended or was canceled, so no controller is waiting on an attempt. */
  async function controllerIsDone(goalRunId: string): Promise<boolean> {
    const record = await store.get(goalRunId);
    return (
      record === undefined ||
      isTerminalGoalStatus(record.status) ||
      record.cancellation !== undefined
    );
  }

  function track<T>(work: Promise<T>): Promise<T> {
    sending.add(work);
    const release = (): void => {
      sending.delete(work);
    };
    work.then(release, release);
    return work;
  }

  /** Waits for the attempt's run to end by whatever means this process has. */
  async function untilEnded(target: AttemptTarget, live: AgentRun<unknown, boolean> | undefined) {
    try {
      // The live handle settles on operative's own event, which is not proof the
      // engine's terminal write has committed, so it is never trusted alone: the
      // engine's handle is awaited as well. The run is durably started by the
      // time anything is watched, so the engine has a workflow to hand back.
      if (live !== undefined) await live.result();
      await getDurable()?.engine.getHandle(target.runId).result();
    } catch {
      // A cancelled, failed, or timed-out workflow rejects its handle; its
      // stored state, read next, says which.
    }
  }

  function watch(target: AttemptTarget, live?: AgentRun<unknown, boolean>): void {
    if (watching.has(target.runId)) return;
    const task = (async (): Promise<void> => {
      await untilEnded(target, live);
      if (isClosing()) return;
      // The controller waits on this signal with no deadline of its own, and
      // recovery runs only at boot, so a transient failure is retried here.
      for (let retry = 0; ; retry += 1) {
        try {
          await track(forward(target));
          return;
        } catch (error) {
          if (isClosing()) return;
          const delay = retryDelaysMs[retry];
          if (delay === undefined) {
            diagnose({
              level: 'error',
              scope: 'goals',
              message: `[bureau] Could not forward the end of attempt ${target.attemptIndex} of goal "${target.goalRunId}"; recovery will send it again: ${describe(error)}`,
              cause: error,
            });
            return;
          }
          await new Promise<void>((resolve) => {
            runtime.timers.setTimeout(resolve, delay);
          });
          if (isClosing()) return;
        }
      }
    })().finally(() => {
      watching.delete(target.runId);
    });
    watching.set(target.runId, task);
  }

  async function reconcile(target: AttemptTarget): Promise<AttemptReconciliation> {
    const outcome = await track(forward(target));
    if (outcome === 'watching') watch(target);
    return outcome;
  }

  async function drain(): Promise<void> {
    while (sending.size > 0) await Promise.allSettled(sending);
  }

  return { watch, reconcile, drain };
}
