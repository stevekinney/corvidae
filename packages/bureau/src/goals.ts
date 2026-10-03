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
  FreshAttemptArtifactError,
  type FreshAttemptSourceResolver,
  GoalConfigurationError,
  type GoalRunStatus,
  validateFreshAttemptArtifact,
} from '@lostgradient/operative';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { cancelGoal, settleCanceledGoal } from './goal-cancellation';
import { cleanUpGoal, isCleanupDone } from './goal-cleanup';
import { ensureController, type GoalControlDependencies } from './goal-controller';
import { recoverEveryGoal, recoverGoal, UNREADABLE_RECORD_DETAIL } from './goal-recovery';
import {
  createGoalState,
  GoalObjectiveTooLargeError,
  GoalRunIdError,
  type GoalState,
  InvalidGoalStateError,
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
}

const NO_ENGINE_TO_READ_RUN =
  "This bureau has no durable engine, so the run's workflow status cannot be read.";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * JSON with object keys sorted and `undefined` members dropped, so two requests
 * that list the same configuration in another key order (an artifact, a budget,
 * an identity) compare equal. Arrays keep their order: it is part of the value.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.keys(value)
      .toSorted()
      .flatMap((key) => {
        const member: unknown = (value as Record<string, unknown>)[key];
        return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
      });
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The parts of a record that a create request determines, for telling a repeat from a conflict. */
function configurationOf(state: GoalState): string {
  return canonicalJson([
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

    const conversationPolicy = request.conversationPolicy;
    const goalRunId = request.goalRunId ?? runtime.identifiers.next('goal-run');

    // The record this request describes, built from the request alone: nothing
    // in it depends on what the bureau can do today (the validator's identity is
    // the one requested, which the catalog only confirms), so a repeat can be
    // compared to what is stored before any current capability is consulted. A
    // request that cannot be built is reported where it always was, below.
    let built: { readonly state: GoalState } | { readonly error: unknown };
    try {
      built = {
        state: createGoalState({
          goalRunId,
          identity: request.identity,
          objective: {
            agentName: request.agentName,
            prompt: request.prompt,
            ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
          },
          validator: { name: request.validator.name, version: request.validator.version },
          requireDeterministicValidation: request.requireDeterministicValidation,
          validatorTimeoutMs: request.validatorTimeoutMs,
          conversationPolicy: request.conversationPolicy ?? { kind: 'continue' },
          retryPolicy: request.retryPolicy,
          bounds: request.bounds,
          principal: request.principal,
          now: clock.nowISO(),
        }),
      };
    } catch (error) {
      built = { error };
    }

    /** A goal under this id is already stored: a repeat of the same request heals it, a different one conflicts. */
    async function repeatOf(
      existing: GoalState,
      state: GoalState,
    ): Promise<BureauGoalCreateOutcome> {
      if (configurationOf(existing) !== configurationOf(state)) {
        // A request from a different principal has no claim on what is stored.
        return principalAllows(request.principal, existing.principal)
          ? { outcome: 'conflict', goal: existing }
          : { outcome: 'conflict' };
      }
      if (isTerminalGoalStatus(existing.status)) return { outcome: 'existing', goal: existing };
      // A controller is not started once the bureau is shutting down; the goal
      // is still the one that was asked for, and the caller is told so.
      if (isClosing()) {
        return {
          outcome: 'existing',
          goal: existing,
          controller: { status: 'start-failed', reason: 'The bureau is shutting down.' },
        };
      }
      // The first call may have died between recording the goal and starting
      // its controller; repeating it is how a caller heals that. A controller
      // that cannot be ensured now (no engine, a start that fails) is reported
      // in `controller`: it does not turn a recognized repeat into a refusal.
      const ensured = await ensureController(dependencies, existing);
      return { outcome: 'existing', goal: ensured.goal, controller: ensured.controller };
    }

    // An id already in the store decides the call before anything about the
    // bureau's present capabilities does: a repeat of a request that was accepted
    // is `existing` (or `conflict`) even when its engine, agent, or validator is
    // gone now, and for a goal that has ended. Those checks decide a new record.
    // A request that could not be built (an id the store cannot key, say) names
    // no record, so it is never looked up.
    if (request.goalRunId !== undefined && 'state' in built) {
      const stored = await store.get(goalRunId);
      if (stored !== undefined) return repeatOf(stored, built.state);
      if (await store.isUnreadable(goalRunId)) {
        return rejected(
          'record-unreadable',
          `The record stored for goal "${goalRunId}" is unreadable.`,
        );
      }
    }

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
    // is recorded rather than failing on its first retry. It decides only a goal
    // that is not already stored: a check that depends on the time it runs (the
    // retention window, a source that has since gone) must not turn a repeated
    // `create` into a refusal, which is how a caller heals a crash between
    // recording the goal and starting its controller.
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

    if ('error' in built) {
      const { error } = built;
      if (artifactRefusal !== undefined) return artifactRefusal;
      if (error instanceof GoalObjectiveTooLargeError) {
        return rejected('objective-too-large', error.message);
      }
      if (error instanceof GoalRunIdError) return rejected('invalid-goal-run-id', error.message);
      if (error instanceof GoalConfigurationError) {
        return rejected('invalid-configuration', `${error.reason}: ${error.message}`);
      }
      // A request the record decoder would refuse is a configuration to correct,
      // not an exception: `createGoalState` names the invariant it broke.
      if (error instanceof InvalidGoalStateError) {
        return rejected('invalid-configuration', error.message);
      }
      throw error;
    }
    const { state } = built;
    if (artifactRefusal !== undefined) return artifactRefusal;

    const created = await store.create(state);
    if (created.status === 'duplicate') {
      if (created.existing === undefined) {
        return rejected(
          'record-unreadable',
          `The record stored for goal "${goalRunId}" is unreadable.`,
        );
      }
      return repeatOf(created.existing, state);
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
    // Neither is a bureau with no durable engine: it cannot look, which is not
    // the same as looking and finding no workflow.
    let runStatusError: string | undefined;
    const engine = getEngine();
    let run: Awaited<ReturnType<NonNullable<typeof engine>['get']>> | undefined;
    if (engine === undefined) {
      runStatusError = NO_ENGINE_TO_READ_RUN;
    } else {
      run = await engine.get(work.runId).catch((error: unknown) => {
        runStatusError = describe(error);
        return null;
      });
    }
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
      const settled = await settleCanceledGoal(dependencies, record, {
        scoped: query?.principal !== undefined,
      });
      if (settled.outcome === 'not-found' || settled.outcome === 'record-unreadable') {
        return settled;
      }
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
        return await finishClosure(closed.record);
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

  /**
   * Applies the checkpoint retention a closure owes and, once nothing is left
   * owed, records it on the goal (`cleanedUpAt`). The closure is already
   * committed, so a process that dies before this ends is finished by the next
   * boot's sweep, and one whose cleanup could not finish leaves the goal
   * unmarked for the next `close()` or boot to retry. The acknowledgement is
   * the truthful result of this attempt either way.
   */
  async function finishClosure(
    record: GoalState,
  ): Promise<Extract<BureauGoalCloseOutcome, { outcome: 'closed' }>> {
    const cleanup = await cleanUpGoal(dependencies, record);
    if (!isCleanupDone(cleanup) || record.cleanedUpAt !== undefined) {
      return { outcome: 'closed', goal: record, cleanup };
    }
    const marked = await store.markCleanedUp(record.goalRunId, clock.nowISO());
    return {
      outcome: 'closed',
      goal: marked.status === 'updated' || marked.status === 'unchanged' ? marked.record : record,
      cleanup,
    };
  }

  return { create, get: authorized, list, active, cancel, recover, close };
}
