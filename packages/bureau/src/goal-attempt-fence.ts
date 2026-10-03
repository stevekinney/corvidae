/**
 * COR-851 — the self-fence of a goal attempt's run.
 *
 * There is no transaction across the attempt's catalog claim (a write to the
 * recovery record's key) and the engine's start of its workflow, and Weft's
 * `engine.start` takes no precondition on stored bytes. So no check made from
 * outside can close the window between the two: a start that has claimed its run
 * but not yet created it can be overtaken by a cancellation, an exhausted
 * duration, or a close, and then create a run nothing is looking for. What can be
 * done is to make the run refuse to work once it exists. This file is that
 * refusal, and it is the backstop that sits after the non-atomic start and before
 * any side effect.
 *
 * The fence is a `prepareStep` hook registered in the run's own hook tier, ahead
 * of every other `prepareStep` handler, so it runs before the first generate or
 * tool call of every step, on a fresh start and on a recovered run alike. It
 * lets the step proceed only when both of these are read now:
 *
 * - the goal's record exists and is neither terminal nor marked for cancellation;
 * - the attempt's catalog claim is the goal's own for this attempt and is not
 *   tombstoned. A goal that ends, closes, or is canceled tombstones the claims of
 *   the attempts it may have overtaken (see `goal-cancellation.ts`), so a start
 *   that lost the race finds the tombstone here.
 *
 * It fails closed. A read that fails is tried again a bounded number of times;
 * if it still cannot be read the step does not run, because a step that ran on an
 * unknown is exactly what the fence exists to prevent. A fence that stops a run
 * ends it with a tripwire error, which no `onError` hook can retry or skip, so
 * the run takes zero agent steps and finishes cleanly.
 *
 * Residual: a run whose start was overtaken still exists, as a workflow that
 * ended after zero steps under the attempt's deterministic id. `cleanUpGoal`
 * prunes every attempt id up to `maximumAttempts` at close and at the boot sweep,
 * so that record is retired with the rest of the goal's history.
 */

import type { HookRegistry } from '@lostgradient/lifecycle';
import { GuardrailTripwireError, type OperativeHookMap } from '@lostgradient/operative';

import { type RunRecordReader } from './goal-ownership';
import { isTerminalGoalStatus } from './goal-state';
import type { GoalStore } from './goal-store';

/** The attempt a run was started for. */
export interface GoalAttemptTarget {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly runId: string;
}

export interface GoalAttemptFence {
  /**
   * Whether the attempt's run may take a step, from reads made now. `false` is a
   * verdict; a rejection is a read that could not be made, which the hook treats
   * as a refusal after its tries.
   */
  mayRun(target: GoalAttemptTarget): Promise<boolean>;
}

/** The id the fence's hook is registered under. */
export const GOAL_ATTEMPT_FENCE_HOOK_ID = 'bureau:goal-attempt-fence';

/** How many times the fence reads before it treats the answer as unknown and refuses. */
export const GOAL_ATTEMPT_FENCE_READ_TRIES = 3;

/**
 * The fence over the goal store and the recovery records. `undefined` for the
 * record is a goal that cannot be read as well as one that does not exist, and
 * neither may run.
 */
export function createGoalAttemptFence(dependencies: {
  readonly store: Pick<GoalStore, 'get'>;
  readonly readRunRecord: RunRecordReader;
}): GoalAttemptFence {
  return {
    async mayRun(target) {
      const record = await dependencies.store.get(target.goalRunId);
      if (
        record === undefined ||
        record.cancellation !== undefined ||
        isTerminalGoalStatus(record.status)
      ) {
        return false;
      }
      const load = await dependencies.readRunRecord(target.runId);
      if (load.status === 'read-error') throw load.error;
      if (load.status !== 'found') return false;
      const claimed = load.record.goalAttempt;
      return (
        claimed?.goalRunId === target.goalRunId &&
        claimed.attemptIndex === target.attemptIndex &&
        claimed.tombstonedAt === undefined
      );
    },
  };
}

/** A fence the bureau has not bound yet: it refuses, so a step that beats the binding fails closed. */
export class GoalAttemptFenceUnboundError extends Error {
  constructor() {
    super('A goal attempt ran a step before Bureau bound the goal attempt fence.');
    this.name = 'GoalAttemptFenceUnboundError';
  }
}

export interface GoalAttemptFenceHost {
  /** The fence to hand to the runtime composition and the dispatcher, which exist before the goal store does. */
  readonly fence: GoalAttemptFence;
  bind(fence: GoalAttemptFence): void;
}

/**
 * The runtime composition and the catalog dispatcher are built before the goal
 * store and the recovery-record reader the fence needs, so they hold a fence that
 * forwards to whatever is bound later, and refuses until then.
 */
export function createGoalAttemptFenceHost(): GoalAttemptFenceHost {
  let bound: GoalAttemptFence | undefined;
  return {
    fence: {
      mayRun: (target) =>
        Promise.resolve().then(() => {
          if (bound === undefined) throw new GoalAttemptFenceUnboundError();
          return bound.mayRun(target);
        }),
    },
    bind(fence) {
      bound = fence;
    },
  };
}

const refusal = (target: GoalAttemptTarget, detail: string): GuardrailTripwireError =>
  new GuardrailTripwireError(
    `Attempt ${target.attemptIndex} of goal "${target.goalRunId}" may not run: ${detail}.`,
    {
      guardrailName: 'goal-attempt-fence',
      category: 'goal-attempt-fence',
      phase: 'input',
      confidence: 1,
      detail,
    },
  );

/**
 * Registers the fence as the first `prepareStep` handler of a run's invariant
 * tier. The hook reads nothing it can change and writes nothing, so replaying it
 * is safe.
 */
export function registerGoalAttemptFence(
  registry: HookRegistry<OperativeHookMap>,
  fence: GoalAttemptFence,
  target: GoalAttemptTarget,
): void {
  registry.on(
    'prepareStep',
    async () => {
      let verdict: boolean | undefined;
      let cause: unknown;
      for (let attempt = 0; verdict === undefined && attempt < GOAL_ATTEMPT_FENCE_READ_TRIES;) {
        attempt += 1;
        try {
          verdict = await fence.mayRun(target);
        } catch (error) {
          cause = error;
        }
      }
      if (verdict === true) return;
      throw verdict === false
        ? refusal(
            target,
            'the goal ended, was canceled, or no longer holds this attempt (its claim is tombstoned)',
          )
        : refusal(
            target,
            `the goal and the attempt's claim could not be read (${cause instanceof Error ? cause.message : String(cause)}), and a step is never taken on an unknown`,
          );
    },
    { id: GOAL_ATTEMPT_FENCE_HOOK_ID, replay: 'safe' },
  );
}
