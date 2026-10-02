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
  GoalConfigurationError,
  type GoalRunStatus,
} from '@lostgradient/operative';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { cancelGoal } from './goal-cancellation';
import { ensureController, type GoalControlDependencies } from './goal-controller';
import { recoverEveryGoal, recoverGoal } from './goal-recovery';
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
  const { store, catalog, runtime, clock, getEngine, planAgent, isClosing } = dependencies;

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
    // A durable goal has no live conversation to fork and no artifact handoff,
    // so only `continue` is honored; the others are refused, never run as it.
    const policy = request.conversationPolicy?.kind ?? 'continue';
    if (policy !== 'continue') {
      return rejected(
        'unsupported-conversation-policy',
        `A durable goal supports only the "continue" conversation policy, not "${policy}".`,
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
      if (error instanceof GoalRunIdError) return rejected('invalid-goal-run-id', error.message);
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
      const { existing } = created;
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
      if (goalRunId === undefined) {
        return await recoverEveryGoal(dependencies, (record) =>
          principalAllows(query?.principal, record.principal),
        );
      }
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
        return {
          outcome: 'closed',
          goal: closed.record,
          cleanup: await cleanUp(goalRunId),
        };
      case 'rejected':
        return { outcome: 'not-terminal', goal: closed.record };
      case 'stale':
        return { outcome: 'contended', goal: closed.record };
      case 'missing':
      case 'corrupt':
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
