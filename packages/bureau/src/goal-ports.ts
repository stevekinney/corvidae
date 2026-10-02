/**
 * COR-851 — Bureau's side of the durable `goalRun` workflow.
 *
 * Operative owns the controller and cannot import Bureau, so everything the
 * controller does to the world crosses `GoalWorkflowPorts`. This file implements
 * those ports over Bureau's goal store, validator catalog, and durable agent
 * runs, and supplies the late binding that lets the workflow be registered
 * with the engine before the rest of Bureau exists.
 *
 * Every port runs inside a Weft activity, so each may run more than once and
 * each is idempotent:
 *
 * - `loadGoalState` and `commitTransition` are the store's own reads and
 *   compare-and-swap, so a replayed commit answers `duplicate`.
 * - `startAttempt` is start-or-adopt. The attempt's run id is deterministic, so
 *   a run that already exists is adopted, a claim left by a start that died
 *   before its workflow existed is completed from the claim, and otherwise the
 *   run starts. Either way a forwarder is attached.
 * - `runValidator` may run twice after a crash. The decision is committed once
 *   (the store keeps the first), so a validator without side effects is simply
 *   run again; one that has them should say so with `determinism`.
 * - `abortAttempt` is `cancelDurableRun`, which is a no-op for a run that never
 *   existed or already ended.
 *
 * Each attempt is a fresh durable run, not a turn in a long conversation. The
 * in-memory controller continues, forks, or restarts a live session; a durable
 * goal has no live session to do that to, so the retry's prompt carries the
 * validator's feedback in its text. `fresh-from-artifact` carries none.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type AgentRun,
  ATTEMPT_RUN_FAILURE_DETAIL,
  createGoalWorkflow,
  type DurableActiveRunContext,
  executeValidator,
  type GoalAttemptRecord,
  type GoalWorkflowAbortRequest,
  type GoalWorkflowCommit,
  type GoalWorkflowLoad,
  type GoalWorkflowPorts,
  type GoalWorkflowStart,
  type GoalWorkflowStartRequest,
  type GoalWorkflowTransition,
  type GoalWorkflowValidatorRequest,
  isAgentRunWorkflowInput,
  type ProjectedValidatorOutcome,
  type ProjectedValidatorResult,
  projectValidatorResult,
  readDurableRunResult,
  type RunOptions,
} from '@lostgradient/operative';

import type { GoalAttemptStart } from './bureau-catalog-dispatch';
import type { AttemptForwarder } from './goal-forwarder';
import {
  boundValidationOutcome,
  type DurableGoalAttempt,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  type GoalState,
  goalTransitionId,
} from './goal-state';
import type { GoalStore } from './goal-store';
import type { GoalValidatorCatalog } from './goal-validator-catalog';
import type { CancelDurableRunOutcome } from './types';

/** The deterministic names the workflow and the store share. */
export const goalIdentifiers: GoalWorkflowPorts['identifiers'] = {
  transitionId: goalTransitionId,
  attemptId: goalAttemptId,
  attemptRunId: goalAttemptRunId,
  decisionId: goalDecisionId,
};

// ---------------------------------------------------------------------------
// Late binding
// ---------------------------------------------------------------------------

/** A goal port ran before Bureau finished composing the goal control plane. */
export class GoalPortsUnboundError extends Error {
  constructor(port: string) {
    super(`The goal port "${port}" ran before Bureau bound the goal control plane.`);
    this.name = 'GoalPortsUnboundError';
  }
}

export interface GoalWorkflowHost {
  /** The workflow to register with `createRunEngine({ goalWorkflow })`. */
  readonly workflow: ReturnType<typeof createGoalWorkflow>;
  /** The ports the workflow closes over: forwarders to whatever is bound, or loud failures until then. */
  readonly ports: GoalWorkflowPorts;
  /** Supplies the real ports once everything they close over exists. */
  bind(ports: GoalWorkflowPorts): void;
}

/**
 * The durable engine is built inside the runtime composition, which knows
 * neither the agent catalog nor the goal store. The workflow it registers
 * therefore closes over ports that forward to whatever is bound later, and a
 * port called before then fails its activity loudly rather than answering.
 */
export function createGoalWorkflowHost(): GoalWorkflowHost {
  let bound: GoalWorkflowPorts | undefined;
  const need = (port: string): GoalWorkflowPorts => {
    if (bound === undefined) throw new GoalPortsUnboundError(port);
    return bound;
  };
  const ports: GoalWorkflowPorts = {
    identifiers: goalIdentifiers,
    loadGoalState: (goalRunId) =>
      Promise.resolve().then(() => need('loadGoalState').loadGoalState(goalRunId)),
    commitTransition: (request) =>
      Promise.resolve().then(() => need('commitTransition').commitTransition(request)),
    startAttempt: (request) =>
      Promise.resolve().then(() => need('startAttempt').startAttempt(request)),
    runValidator: (request) =>
      Promise.resolve().then(() => need('runValidator').runValidator(request)),
    abortAttempt: (request) =>
      Promise.resolve().then(() => need('abortAttempt').abortAttempt(request)),
  };
  return {
    workflow: createGoalWorkflow(ports),
    ports,
    bind(next) {
      bound = next;
    },
  };
}

// ---------------------------------------------------------------------------
// The ports
// ---------------------------------------------------------------------------

export interface GoalPortsDependencies {
  readonly store: GoalStore;
  readonly catalog: GoalValidatorCatalog;
  readonly runtime: RuntimeServices;
  readonly forwarder: AttemptForwarder;
  readonly getDurable: () => DurableActiveRunContext | undefined;
  /** `undefined` when the catalog has no agent by this name. */
  readonly planAgent: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
  readonly startAttemptRun: (start: GoalAttemptStart) => AgentRun<unknown, boolean>;
  readonly cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>;
  readonly resolveCostEstimation: (
    agentName: string,
    prompt: string,
    principal: string | undefined,
  ) => Promise<RunOptions['costEstimation'] | undefined>;
}

/**
 * The prompt attempt `attemptIndex` runs. The first attempt, and every attempt of
 * a `fresh-from-artifact` goal, runs the objective as written; a retry that has
 * validator feedback appends it.
 */
export function attemptPromptFor(
  record: Pick<GoalState, 'objective' | 'conversationPolicy'>,
  attemptIndex: number,
  feedback: string | undefined,
): string {
  const { prompt } = record.objective;
  if (attemptIndex === 0 || feedback === undefined) return prompt;
  return record.conversationPolicy.kind === 'fresh-from-artifact'
    ? prompt
    : `${prompt}\n\n${feedback}`;
}

const failed = (detail: string): GoalWorkflowStart => ({ status: 'failed', detail });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function toAttemptRecord(attempt: DurableGoalAttempt): GoalAttemptRecord {
  return {
    attemptId: attempt.attemptId,
    attemptIndex: attempt.attemptIndex,
    runId: attempt.runId,
    sessionId: attempt.sessionId,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    finishReason: attempt.finishReason,
    validation:
      attempt.validation === undefined
        ? undefined
        : {
            identity: attempt.validation.identity,
            startedAt: attempt.validation.startedAt,
            completedAt: attempt.validation.completedAt,
            outcome: attempt.validation.outcome,
          },
    feedback: attempt.feedback,
    usage: {
      steps: attempt.usage.steps,
      tokens: attempt.usage.tokens,
      costUsd: attempt.usage.costUsd,
    },
    status: attempt.status,
  };
}

export function createGoalPorts(dependencies: GoalPortsDependencies): GoalWorkflowPorts {
  const {
    store,
    catalog,
    runtime,
    forwarder,
    getDurable,
    planAgent,
    startAttemptRun,
    cancelRun,
    resolveCostEstimation,
  } = dependencies;

  /** Never aborts: shutting down is a crash for the next process to recover, not a verdict. */
  const noAbort = new AbortController().signal;

  async function loadGoalState(goalRunId: string): Promise<GoalWorkflowLoad> {
    return { record: await store.get(goalRunId), nowMs: runtime.clock.now() };
  }

  async function commitTransition(request: GoalWorkflowTransition): Promise<GoalWorkflowCommit> {
    const result = await store.applyTransition(request);
    switch (result.status) {
      case 'applied':
      case 'duplicate':
      case 'stale':
        return { status: result.status };
      case 'rejected':
        return { status: 'rejected', reason: result.reason };
      case 'missing':
      case 'corrupt':
        return { status: result.status };
    }
  }

  async function startAttempt(request: GoalWorkflowStartRequest): Promise<GoalWorkflowStart> {
    const record = await store.get(request.goalRunId);
    if (record === undefined) {
      return failed(ATTEMPT_RUN_FAILURE_DETAIL.runStart('the goal record is unavailable'));
    }
    const { agentName } = record.objective;
    const plan = planAgent(agentName);
    if (plan === undefined) {
      return failed(
        ATTEMPT_RUN_FAILURE_DETAIL.runStart(`agent "${agentName}" is no longer in the catalog`),
      );
    }
    const durable = getDurable();
    if (!plan.durable || durable === undefined) {
      return failed(ATTEMPT_RUN_FAILURE_DETAIL.runStart(`agent "${agentName}" cannot run durably`));
    }
    const target = {
      goalRunId: request.goalRunId,
      attemptIndex: request.attemptIndex,
      runId: request.runId,
    };

    const adopt = async (): Promise<GoalWorkflowStart | undefined> => {
      const existing = await durable.engine.get(request.runId);
      if (existing === null) return undefined;
      if (!isAgentRunWorkflowInput(existing.input) || existing.input.runId !== request.runId) {
        return failed(
          ATTEMPT_RUN_FAILURE_DETAIL.runStart(
            `run id "${request.runId}" names a different workflow`,
          ),
        );
      }
      forwarder.watch(target);
      return { status: 'adopted', sessionId: request.runId };
    };

    const adopted = await adopt();
    if (adopted !== undefined) return adopted;
    let live: AgentRun<unknown, boolean>;
    try {
      live = startAttemptRun({
        agentName,
        input: attemptPromptFor(record, request.attemptIndex, request.feedback),
        runId: request.runId,
        ...(record.principal === undefined ? {} : { principal: record.principal }),
      });
    } catch (error) {
      // A start that raced this one is success; anything else fails the
      // activity, which the controller treats as its own failure and recovery
      // restarts, rather than ending the goal over a transient fault.
      const raced = await adopt();
      if (raced !== undefined) return raced;
      throw error;
    }
    forwarder.watch(target, live);
    return { status: 'started', sessionId: request.runId };
  }

  async function runValidator(
    request: GoalWorkflowValidatorRequest,
  ): Promise<ProjectedValidatorResult> {
    const startedAt = runtime.clock.nowISO();
    const unavailable = (
      kind: 'error' | 'unavailable',
      code: string,
      message: string,
    ): ProjectedValidatorResult => {
      const error = { kind: 'load' as const, code, message };
      const outcome: ProjectedValidatorOutcome =
        kind === 'unavailable' ? { kind, error, reason: message } : { kind, error };
      return {
        identity: request.validator,
        startedAt,
        completedAt: runtime.clock.nowISO(),
        outcome,
      };
    };

    const resolution = catalog.resolve(request.validator);
    if (!resolution.ok) {
      const message =
        resolution.reason === 'missing'
          ? `The validator "${request.validator.name}@${request.validator.version}" is not registered.`
          : `The validator "${request.validator.name}" has no version "${request.validator.version}"; registered: ${resolution.availableVersions.join(', ')}.`;
      return unavailable(
        'unavailable',
        resolution.reason === 'missing' ? 'VALIDATOR_MISSING' : 'VALIDATOR_VERSION_MISMATCH',
        message,
      );
    }

    const record = await store.get(request.goalRunId);
    const attempt = record?.attempts[request.attemptIndex];
    const durable = getDurable();
    if (record === undefined || attempt === undefined || durable === undefined) {
      return unavailable(
        'error',
        'ATTEMPT_UNAVAILABLE',
        `Attempt ${request.attemptIndex} of goal "${request.goalRunId}" cannot be read.`,
      );
    }
    const costEstimation =
      record.bounds.maximumTotalCostUsd === undefined
        ? undefined
        : await resolveCostEstimation(
            record.objective.agentName,
            record.objective.prompt,
            record.principal,
          ).catch(() => undefined);
    const reading = await readDurableRunResult(durable, attempt.runId, {
      runtime,
      costEstimation,
    }).catch((error: unknown) => ({ status: 'unreadable' as const, detail: describe(error) }));
    if (reading.status !== 'completed') {
      return unavailable(
        'error',
        'ATTEMPT_RESULT_UNAVAILABLE',
        `The result of run "${attempt.runId}" cannot be read (${reading.status}).`,
      );
    }

    const execution = await executeValidator(
      resolution.entry.validator,
      {
        goalRunId: request.goalRunId,
        attemptId: request.attemptId,
        attemptIndex: request.attemptIndex,
        result: reading.result,
        history: record.attempts.slice(0, request.attemptIndex).map(toAttemptRecord),
      },
      noAbort,
      { timeoutMs: request.validatorTimeoutMs, runtime },
    );
    const projected = projectValidatorResult({
      identity: resolution.entry.identity,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      outcome: execution.outcome,
    });
    return { ...projected, outcome: boundValidationOutcome(projected.outcome) };
  }

  async function abortAttempt(request: GoalWorkflowAbortRequest): Promise<void> {
    const outcome = await cancelRun(request.runId);
    if (outcome.status === 'failed') {
      throw outcome.error instanceof Error ? outcome.error : new Error(describe(outcome.error));
    }
  }

  return {
    identifiers: goalIdentifiers,
    loadGoalState,
    commitTransition,
    startAttempt,
    runValidator,
    abortAttempt,
  };
}
