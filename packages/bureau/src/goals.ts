/**
 * COR-851 — `bureau.goals`: the control plane over durable goals.
 *
 * A goal is three things that must agree: a record (`GoalState`) that is the
 * truth, a Weft workflow that is its single-owner controller, and one durable
 * agent run per attempt. This file creates, reads, and closes goals; the pieces
 * that touch all three live beside it (`goal-cancellation.ts`,
 * `goal-recovery.ts`, `goal-ports.ts`).
 *
 * ## Authorization
 *
 * Each operation takes an optional `principal`, compared with the one the goal
 * was created under exactly as `bureau.children` compares them: omitting it is
 * a trusted, internal call, and a mismatch reads as `not-found`, so a caller
 * cannot tell "wrong id" from "not yours".
 */

import {
  type CleanupAcknowledgement,
  FreshAttemptArtifactError,
  type FreshAttemptSourceResolver,
  GoalConfigurationError,
  type GoalRunStatus,
  validateFreshAttemptArtifact,
} from '@lostgradient/operative';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { cancelGoal, settleCanceledGoal } from './goal-cancellation';
import { ensureController, type GoalControlDependencies } from './goal-controller';
import { recoverEveryGoal, recoverGoal, UNREADABLE_RECORD_DETAIL } from './goal-recovery';
import {
  createGoalState,
  GoalObjectiveTooLargeError,
  GoalRunIdError,
  type GoalState,
  goalWorkflowId,
  isTerminalGoalStatus,
} from './goal-state';
import type {
  BureauGoalActiveWork,
  BureauGoalCancelOptions,
  BureauGoalCloseOutcome,
  BureauGoalCreateOutcome,
  BureauGoalListOptions,
  BureauGoalQuery,
  BureauGoalRecoveryReport,
  BureauGoalRequest,
  BureauGoals,
} from './goal-types';
import { principalAllows } from './principal-allows';

export interface BureauGoalsDependencies extends GoalControlDependencies {
  readonly runtime: Pick<RuntimeServices, 'identifiers'>;
  /** See `BureauOptions.resolveFreshAttemptSource`. */
  readonly resolveFreshAttemptSource: FreshAttemptSourceResolver | undefined;
  /** `undefined` when the catalog has no agent by this name. */
  readonly planAgent: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
  /**
   * Applies the bureau's checkpoint retention to a terminal controller
   * workflow's history and says truthfully how it went. Never rejects.
   */
  readonly cleanupController: (workflowId: string) => Promise<CleanupAcknowledgement>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The parts of a record that a create request determines, for telling a repeat from a conflict. */
function configurationOf(state: GoalState): string {
  return JSON.stringify([
    state.identity,
    state.objective,
    state.validator,
    state.requireDeterministicValidation,
    state.validatorTimeoutMs ?? null,
    state.conversationPolicy,
    state.retryPolicy ?? null,
    state.bounds,
    state.principal ?? null,
  ]);
}

export function createBureauGoals<TName extends string = string>(
  dependencies: BureauGoalsDependencies,
): BureauGoals<TName> {
  const {
    store,
    catalog,
    runtime,
    clock,
    getEngine,
    planAgent,
    isClosing,
    resolveFreshAttemptSource,
  } = dependencies;

  async function authorized(
    goalRunId: string,
    query: BureauGoalQuery | undefined,
  ): Promise<GoalState | undefined> {
    const record = await store.get(goalRunId);
    return record !== undefined && principalAllows(query?.principal, record.principal)
      ? record
      : undefined;
  }

  /**
   * What a caller is told when no goal is visible under an id: `not-found`,
   * unless a record is stored there that cannot be decoded, which is a fault and
   * not absence (`create` says the same of the same id). A record that cannot
   * be decoded has no readable owner, so only a caller who may see every goal
   * (no principal) is told so; a principal-scoped caller gets exactly the answer
   * it gets for a goal it does not own or that does not exist.
   */
  async function absent(
    goalRunId: string,
    query: BureauGoalQuery | undefined,
  ): Promise<{ readonly outcome: 'not-found' | 'record-unreadable' }> {
    return query?.principal === undefined && (await store.isUnreadable(goalRunId))
      ? { outcome: 'record-unreadable' }
      : { outcome: 'not-found' };
  }

  async function create(request: BureauGoalRequest<TName>): Promise<BureauGoalCreateOutcome> {
    const rejected = (
      code: Extract<BureauGoalCreateOutcome, { outcome: 'rejected' }>['code'],
      reason: string,
      availableVersions?: readonly string[],
    ): BureauGoalCreateOutcome => ({
      outcome: 'rejected',
      code,
      reason,
      ...(availableVersions === undefined ? {} : { availableVersions }),
    });

    if (isClosing()) return rejected('shutdown', 'The bureau is shutting down.');
    const engine = getEngine();
    if (engine === undefined) {
      return rejected(
        'durable-unavailable',
        'Durable goals need a durable engine; this bureau has none.',
      );
    }
    const plan = planAgent(request.agentName);
    if (plan === undefined) {
      return rejected('agent-not-found', `Unknown agent "${request.agentName}".`);
    }
    if (!plan.durable) {
      return rejected(
        'agent-not-durable',
        `Agent "${request.agentName}" cannot run durably, so it cannot run a goal attempt.`,
      );
    }
    const resolution = catalog.resolve(request.validator);
    if (!resolution.ok) {
      return resolution.reason === 'missing'
        ? rejected(
            'validator-missing',
            `The validator "${request.validator.name}@${request.validator.version}" is not registered.`,
          )
        : rejected(
            'validator-version-mismatch',
            `The validator "${request.validator.name}" has no version "${request.validator.version}".`,
            resolution.availableVersions,
          );
    }

    // Everything a `fresh-from-artifact` attempt will check about its artifact,
    // so a goal whose artifact could never seed an attempt is refused before it
    // is recorded rather than failing on its first retry. The outcome is held,
    // not returned: a check that depends on the time it runs (the retention
    // window, a source that has since gone) must not turn a repeated `create` of
    // a goal already recorded into a refusal, which is how a caller heals a
    // crash between recording the goal and starting its controller. It decides
    // only a goal that is not already stored.
    const conversationPolicy = request.conversationPolicy;
    let artifactRefusal: BureauGoalCreateOutcome | undefined;
    if (conversationPolicy?.kind === 'fresh-from-artifact') {
      try {
        await validateFreshAttemptArtifact(conversationPolicy.artifact, {
          resolveSource: resolveFreshAttemptSource ?? (() => undefined),
          now: clock.now(),
        });
      } catch (error) {
        if (!(error instanceof FreshAttemptArtifactError)) throw error;
        artifactRefusal = rejected(
          'invalid-configuration',
          `fresh-from-artifact: ${error.message}`,
        );
      }
    }

    // A durable goal has no session before its first attempt, so the one run a
    // retry can fork through is attempt 0. Any other baseline could never be
    // satisfied, and would only be found out after an attempt had been spent.
    if (conversationPolicy?.kind === 'fork-from-baseline' && conversationPolicy.throughRun !== 0) {
      return rejected(
        'invalid-configuration',
        `fork-from-baseline: throughRun must be 0 for a durable goal, whose only baseline is its first attempt; got ${conversationPolicy.throughRun}.`,
      );
    }

    const goalRunId = request.goalRunId ?? runtime.identifiers.next('goal-run');
    let state: GoalState;
    try {
      state = createGoalState({
        goalRunId,
        identity: request.identity,
        objective: {
          agentName: request.agentName,
          prompt: request.prompt,
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        },
        validator: resolution.entry.identity,
        requireDeterministicValidation: request.requireDeterministicValidation,
        validatorTimeoutMs: request.validatorTimeoutMs,
        conversationPolicy: request.conversationPolicy ?? { kind: 'continue' },
        retryPolicy: request.retryPolicy,
        bounds: request.bounds,
        principal: request.principal,
        now: clock.nowISO(),
      });
    } catch (error) {
      if (artifactRefusal !== undefined) return artifactRefusal;
      if (error instanceof GoalObjectiveTooLargeError) {
        return rejected('objective-too-large', error.message);
      }
      if (error instanceof GoalRunIdError) return rejected('invalid-goal-run-id', error.message);
      if (error instanceof GoalConfigurationError) {
        return rejected('invalid-configuration', `${error.reason}: ${error.message}`);
      }
      throw error;
    }

    /** A goal under this id is already stored: a repeat of the same request heals it, a different one conflicts. */
    async function repeatOf(existing: GoalState): Promise<BureauGoalCreateOutcome> {
      if (configurationOf(existing) !== configurationOf(state)) {
        // A request from a different principal has no claim on what is stored.
        return principalAllows(request.principal, existing.principal)
          ? { outcome: 'conflict', goal: existing }
          : { outcome: 'conflict' };
      }
      if (isTerminalGoalStatus(existing.status)) return { outcome: 'existing', goal: existing };
      // The first call may have died between recording the goal and starting
      // its controller; repeating it is how a caller heals that.
      const ensured = await ensureController(dependencies, existing);
      return { outcome: 'existing', goal: ensured.goal, controller: ensured.controller };
    }

    if (artifactRefusal !== undefined) {
      const existing = await store.get(goalRunId);
      return existing !== undefined && configurationOf(existing) === configurationOf(state)
        ? repeatOf(existing)
        : artifactRefusal;
    }

    const created = await store.create(state);
    if (created.status === 'duplicate') {
      if (created.existing === undefined) {
        return rejected(
          'record-unreadable',
          `The record stored for goal "${goalRunId}" is unreadable.`,
        );
      }
      return repeatOf(created.existing);
    }

    // COR-638: a validator that cannot supply the evidence a goal demands ends
    // it `failed`/`unsupported-validation` before any attempt runs, and the
    // same check guards every other place a controller is started.
    const ensured = await ensureController(dependencies, state);
    return { outcome: 'created', goal: ensured.goal, controller: ensured.controller };
  }

  async function list(options?: BureauGoalListOptions): Promise<GoalState[]> {
    const wanted: readonly GoalRunStatus[] | undefined =
      options?.status === undefined
        ? undefined
        : typeof options.status === 'string'
          ? [options.status]
          : options.status;
    const records = await store.list();
    return records
      .filter(
        (record) =>
          principalAllows(options?.principal, record.principal) &&
          (wanted === undefined || wanted.includes(record.status)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.goalRunId.localeCompare(right.goalRunId),
      );
  }

  async function active(
    goalRunId: string,
    query?: BureauGoalQuery,
  ): Promise<BureauGoalActiveWork | undefined> {
    const record = await authorized(goalRunId, query);
    const work = record?.active;
    if (record === undefined || work === undefined) return undefined;
    const attemptIndex = record.attempts.findIndex(
      (attempt) => attempt.attemptId === work.attemptId,
    );
    if (work.kind === 'validation') {
      return {
        kind: 'validation',
        attemptId: work.attemptId,
        attemptIndex,
        validator: work.validator,
        startedAt: work.startedAt,
      };
    }
    // A read that fails is not a run with no workflow: `runStatus` is `null` for
    // both, so the fault is named beside it.
    let runStatusError: string | undefined;
    const run = await getEngine()
      ?.get(work.runId)
      .catch((error: unknown) => {
        runStatusError = describe(error);
        return null;
      });
    return {
      kind: 'attempt',
      attemptId: work.attemptId,
      attemptIndex,
      runId: work.runId,
      startedAt: work.startedAt,
      runStatus: run?.status ?? null,
      ...(runStatusError === undefined ? {} : { runStatusError }),
    };
  }

  async function cancel(goalRunId: string, options: BureauGoalCancelOptions = {}) {
    const record = await authorized(goalRunId, options);
    return record === undefined
      ? await absent(goalRunId, options)
      : cancelGoal(dependencies, record, options);
  }

  async function recover(
    goalRunId?: string,
    query?: BureauGoalQuery,
  ): Promise<BureauGoalRecoveryReport> {
    try {
      if (goalRunId === undefined) {
        // A record that cannot be decoded has no principal to check, so only a
        // caller who may see every goal is told which ones are unreadable.
        return await recoverEveryGoal(
          dependencies,
          (record) => principalAllows(query?.principal, record.principal),
          query?.principal === undefined,
        );
      }
      if ((await authorized(goalRunId, query)) === undefined) {
        const gone = await absent(goalRunId, query);
        return {
          goals: [
            gone.outcome === 'record-unreadable'
              ? {
                  goalRunId,
                  outcome: 'unrecoverable',
                  detail: UNREADABLE_RECORD_DETAIL(goalRunId),
                }
              : { goalRunId, outcome: 'not-found' },
          ],
          failures: [],
        };
      }
      return { goals: [await recoverGoal(dependencies, goalRunId)], failures: [] };
    } catch (error) {
      return {
        goals: [],
        failures: [{ goalRunId: goalRunId ?? '*', reason: describe(error) }],
      };
    }
  }

  async function close(
    goalRunId: string,
    query?: BureauGoalQuery,
  ): Promise<BureauGoalCloseOutcome> {
    const record = await authorized(goalRunId, query);
    if (record === undefined) return absent(goalRunId, query);
    if (record.status === 'canceled') {
      // A closed goal leaves the boot sweep, so a cancellation whose controller,
      // finalizer, or attempt run is not yet read back as ended must not be
      // closed over: nothing would be left to finish it.
      const settled = await settleCanceledGoal(dependencies, record);
      if (settled.outcome === 'cancellation-pending') {
        return {
          outcome: 'cancellation-pending',
          goal: settled.goal,
          awaiting: settled.awaiting,
        };
      }
    }
    const closed = await store.close(goalRunId, clock.nowISO());
    switch (closed.status) {
      case 'updated':
      case 'unchanged':
        return {
          outcome: 'closed',
          goal: closed.record,
          cleanup: await cleanUp(goalRunId),
        };
      case 'rejected':
        return { outcome: 'not-terminal', goal: closed.record };
      case 'stale':
        return { outcome: 'contended', goal: closed.record };
      case 'corrupt':
        // The record decoded a moment ago and no longer does.
        return query?.principal === undefined
          ? { outcome: 'record-unreadable' }
          : { outcome: 'not-found' };
      case 'missing':
        return { outcome: 'not-found' };
    }
  }

  /** The controller's workflow history, pruned under the bureau's retention; `not-required` with no controller. */
  async function cleanUp(goalRunId: string): Promise<CleanupAcknowledgement> {
    const workflowId = goalWorkflowId(goalRunId);
    try {
      const controller = await getEngine()?.get(workflowId);
      if (controller === null || controller === undefined) return { status: 'not-required' };
      return await dependencies.cleanupController(workflowId);
    } catch (error) {
      return { status: 'failed', error };
    }
  }

  return { create, get: authorized, list, active, cancel, recover, close };
}
