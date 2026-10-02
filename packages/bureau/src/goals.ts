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
  decideDeterminismRequirement,
  GoalConfigurationError,
  type GoalRunStatus,
} from '@lostgradient/operative';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { cancelGoal } from './goal-cancellation';
import { type GoalControlDependencies, startController } from './goal-controller';
import { goalIdentifiers } from './goal-ports';
import { recoverEveryGoal, recoverGoal } from './goal-recovery';
import { createGoalState, GoalObjectiveTooLargeError, type GoalState } from './goal-state';
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
import type { GoalValidatorCatalog } from './goal-validator-catalog';
import { principalAllows } from './principal-allows';

export interface BureauGoalsDependencies extends GoalControlDependencies {
  readonly catalog: GoalValidatorCatalog;
  readonly runtime: Pick<RuntimeServices, 'identifiers'>;
  /** `undefined` when the catalog has no agent by this name. */
  readonly planAgent: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
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
  const { store, catalog, runtime, clock, diagnose, getEngine, planAgent, isClosing } =
    dependencies;

  async function authorized(
    goalRunId: string,
    query: BureauGoalQuery | undefined,
  ): Promise<GoalState | undefined> {
    const record = await store.get(goalRunId);
    return record !== undefined && principalAllows(query?.principal, record.principal)
      ? record
      : undefined;
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
      if (error instanceof GoalObjectiveTooLargeError) {
        return rejected('objective-too-large', error.message);
      }
      if (error instanceof GoalConfigurationError) {
        return rejected('invalid-configuration', `${error.reason}: ${error.message}`);
      }
      throw error;
    }

    const created = await store.create(state);
    if (created.status === 'duplicate') {
      if (created.existing === undefined) {
        return rejected(
          'record-unreadable',
          `The record stored for goal "${goalRunId}" is unreadable.`,
        );
      }
      return configurationOf(created.existing) === configurationOf(state)
        ? { outcome: 'existing', goal: created.existing }
        : { outcome: 'conflict', goal: created.existing };
    }

    // COR-638: a validator that cannot supply the evidence a goal demands ends
    // it as `failed`/`unsupported-validation` before any attempt runs. There is
    // nothing for a controller to do, so none is started.
    const unsupported = decideDeterminismRequirement(
      state.requireDeterministicValidation,
      resolution.entry.descriptor.determinism,
    );
    if (unsupported?.kind === 'fail') {
      const ended = await store.applyTransition({
        goalRunId,
        seq: 1,
        transitionId: goalIdentifiers.transitionId(goalRunId, 1),
        to: 'failed',
        at: clock.nowISO(),
        cause: `fail: ${unsupported.reason}`,
        terminalReason: unsupported.reason,
        ...(unsupported.failureDetail === undefined
          ? {}
          : { failureDetail: unsupported.failureDetail }),
      });
      const goal =
        ended.status === 'applied' || ended.status === 'duplicate' ? ended.record : state;
      return { outcome: 'created', goal, controller: { status: 'not-needed' } };
    }

    try {
      await startController(engine, goalRunId, false);
      return { outcome: 'created', goal: state, controller: { status: 'started' } };
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Goal "${goalRunId}" was recorded but its controller did not start; recover() starts it: ${describe(error)}`,
        cause: error,
      });
      return {
        outcome: 'created',
        goal: state,
        controller: { status: 'start-failed', reason: describe(error) },
      };
    }
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
    const run = await getEngine()
      ?.get(work.runId)
      .catch(() => null);
    return {
      kind: 'attempt',
      attemptId: work.attemptId,
      attemptIndex,
      runId: work.runId,
      startedAt: work.startedAt,
      runStatus: run?.status ?? null,
    };
  }

  async function cancel(goalRunId: string, options: BureauGoalCancelOptions = {}) {
    const record = await authorized(goalRunId, options);
    return record === undefined
      ? ({ outcome: 'not-found' } as const)
      : cancelGoal(dependencies, record, options);
  }

  async function recover(
    goalRunId?: string,
    query?: BureauGoalQuery,
  ): Promise<BureauGoalRecoveryReport> {
    try {
      if (goalRunId === undefined) return await recoverEveryGoal(dependencies);
      if ((await authorized(goalRunId, query)) === undefined) {
        return { goals: [{ goalRunId, outcome: 'not-found' }], failures: [] };
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
    if ((await authorized(goalRunId, query)) === undefined) return { outcome: 'not-found' };
    const closed = await store.close(goalRunId, clock.nowISO());
    switch (closed.status) {
      case 'updated':
      case 'unchanged':
        return { outcome: 'closed', goal: closed.record };
      case 'rejected':
        return { outcome: 'not-terminal', goal: closed.record };
      case 'stale':
        return { outcome: 'contended', goal: closed.record };
      case 'missing':
      case 'corrupt':
        return { outcome: 'not-found' };
    }
  }

  return { create, get: authorized, list, active, cancel, recover, close };
}
