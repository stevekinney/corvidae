/**
 * COR-851 — proof that what a goal adopts, stops, or signals is the goal's own.
 *
 * Every id a goal uses is a deterministic function of its caller-chosen
 * `goalRunId`: the controller workflow (`goal:<id>`), each attempt's run
 * (`goal-<id>-a<n>`), and its sessions (`goal-<id>-s<n>`). Determinism is what
 * makes a restart find its own work, and it is also what lets another goal, an
 * ordinary run, or another principal already be holding an id the goal is about
 * to treat as its own. An id is never ownership. This file is the single place
 * that decides, from a marker the goal's own start wrote, whether an existing
 * run or workflow belongs to the goal.
 *
 * - A run is the goal's when its catalog recovery record carries
 *   `goalAttempt: { goalRunId, attemptIndex }` that reproduces the run's id, and
 *   names the goal's agent and principal.
 * - A controller is the goal's when its workflow type is the goal workflow and
 *   its input names the goal.
 * - A session is checked by `goal-conversation.ts` against the `goalRunId` and
 *   authority its own writes recorded.
 *
 * Ownership is checked at the point of use, and the ids are also reserved: an
 * ordinary caller may not choose a run, child run, session, or schedule id in a
 * goal's namespace (`reserved-identifiers.ts`). The reservation exists because
 * ownership cannot protect everything: Weft purges every event carrying a
 * workflow's id when it retires that workflow, so an ordinary workflow that
 * merely shares a goal's audit id would erase the audit trail. The check at the
 * point of use stays as defence in depth, and it covers every other way an id
 * can come to be occupied, including a store written by something else.
 *
 * Two layers use that check. The start-attempt port verifies explicitly, because it
 * must tell "absent" from "foreign" and answer a typed failure. Everything
 * else (cancel, recovery, the read-back, the forwarder) sees the world through
 * `createOwnedGoalEngine` and `createOwnedRunCanceller`, under which a workflow
 * or run the goal does not own does not exist: it is never read, signalled,
 * resumed, cancelled, replaced, or waited on.
 */

import { GOAL_WORKFLOW_TYPE } from '@lostgradient/operative';

import { goalAttemptRunId } from './goal-state';
import type { GoalEngine } from './goal-types';
import type { CatalogRunRecoveryLoad, CatalogRunRecoveryRecord } from './runtime-composition';
import type { CancelDurableRunOutcome } from './types';

/** An id a goal tried to use belongs to something that is not the goal. */
export class GoalOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalOwnershipError';
  }
}

/**
 * Ownership could not be decided because the record that decides it could not
 * be read. This is neither "foreign" nor "absent": it says nothing about who
 * holds the id, and the same read can succeed once the fault clears. Nothing is
 * adopted, replaced, started over, or cancelled on it, and callers retry.
 */
export class GoalOwnershipUnknownError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`Ownership of run "${runId}" could not be determined: its record could not be read.`, {
      cause,
    });
    this.name = 'GoalOwnershipUnknownError';
  }
}

/**
 * A recovery record is stored at the id but is not a valid record, so who holds
 * the run cannot be decided and never will be by reading again. It is not
 * absent, so nothing is adopted, replaced, started over, or cancelled; it is
 * not retried either. It surfaces as `corrupt-ownership-record` for an
 * operator to repair.
 */
export class GoalCorruptOwnershipRecordError extends GoalOwnershipError {
  constructor(runId: string) {
    super(
      `corrupt-ownership-record: the recovery record for run "${runId}" exists but is not valid, so its owner cannot be determined.`,
    );
    this.name = 'GoalCorruptOwnershipRecordError';
  }
}

export type RunRecordReader = (runId: string) => Promise<CatalogRunRecoveryLoad>;

export interface ExpectedAttemptOwner {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly agentName: string;
  readonly principal: string | undefined;
}

/** Whether a run's recovery record is the goal's own for exactly this attempt. */
export function isOwnAttemptRecord(
  record: CatalogRunRecoveryRecord,
  expected: ExpectedAttemptOwner,
): boolean {
  return (
    record.goalAttempt?.goalRunId === expected.goalRunId &&
    record.goalAttempt.attemptIndex === expected.attemptIndex &&
    record.agentName === expected.agentName &&
    record.principal === expected.principal
  );
}

export type AttemptRunOwnership =
  | { readonly status: 'owned' }
  /** Nothing holds the id: no claim and no workflow. */
  | { readonly status: 'absent' }
  | { readonly status: 'foreign'; readonly detail: string }
  /** A record is present but invalid; `detail` leads with `corrupt-ownership-record`. */
  | { readonly status: 'corrupt'; readonly detail: string };

/**
 * Who holds an attempt's deterministic run id. A claim with no workflow is the
 * goal's own start that died between the two; a workflow with no goal marker, or
 * one marked for a different goal, attempt, agent, or principal, is not.
 */
export async function verifyAttemptRun(
  dependencies: {
    readonly engine: Pick<GoalEngine, 'get'>;
    readonly readRunRecord: RunRecordReader;
  },
  expected: ExpectedAttemptOwner,
  runId: string,
): Promise<AttemptRunOwnership> {
  const load = await dependencies.readRunRecord(runId);
  if (load.status === 'read-error') throw new GoalOwnershipUnknownError(runId, load.error);
  if (load.status === 'corrupt') {
    return { status: 'corrupt', detail: new GoalCorruptOwnershipRecordError(runId).message };
  }
  if (load.status === 'found') {
    return isOwnAttemptRecord(load.record, expected)
      ? { status: 'owned' }
      : {
          status: 'foreign',
          detail: `run id "${runId}" is held by a run that was not started for this goal attempt`,
        };
  }
  return (await dependencies.engine.get(runId)) === null
    ? { status: 'absent' }
    : {
        status: 'foreign',
        detail: `run id "${runId}" is held by a run that was not started by a goal`,
      };
}

const CONTROLLER_PREFIX = 'goal:';
const ATTEMPT_RUN_PREFIX = 'goal-';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Whether a workflow stored at a controller id is the goal's own controller. */
export function isOwnController(
  state: { readonly type: string; readonly input: unknown },
  workflowId: string,
): boolean {
  return (
    state.type === GOAL_WORKFLOW_TYPE &&
    isRecord(state.input) &&
    state.input['goalRunId'] === workflowId.slice(CONTROLLER_PREFIX.length)
  );
}

/** Whether a goal-namespaced run's record proves the id is the one that goal's attempt produces. */
function isGoalNamedRun(load: CatalogRunRecoveryLoad, runId: string): boolean {
  return (
    load.status === 'found' &&
    load.record.goalAttempt !== undefined &&
    goalAttemptRunId(load.record.goalAttempt.goalRunId, load.record.goalAttempt.attemptIndex) ===
      runId
  );
}

/**
 * The engine as a goal is allowed to see it. A workflow at a controller id that
 * is not the goal's controller, and a run at an attempt id that no goal marked
 * as its own, read as absent; acting on one throws {@link GoalOwnershipError},
 * and starting a controller over one (which `start-new` would otherwise
 * replace) is refused.
 */
export function createOwnedGoalEngine<E extends GoalEngine>(
  engine: E,
  readRunRecord: RunRecordReader,
): E {
  const isController = (id: string): boolean => id.startsWith(CONTROLLER_PREFIX);
  const ownedController = async (id: string): Promise<boolean> => {
    const state = await engine.get(id);
    return state === null || isOwnController(state, id);
  };
  const refuse = (id: string): never => {
    throw new GoalOwnershipError(`Workflow "${id}" is not a goal controller for this goal.`);
  };

  const overrides: Record<string, (...args: never[]) => unknown> = {
    get: async (id: string) => {
      const state = await engine.get(id);
      if (state === null) return null;
      if (isController(id)) return isOwnController(state, id) ? state : null;
      if (id.startsWith(ATTEMPT_RUN_PREFIX)) {
        const load = await readRunRecord(id);
        // A record that cannot be read does not say the run is foreign or
        // absent; surface it so the caller retries instead of acting on a guess.
        if (load.status === 'read-error') throw new GoalOwnershipUnknownError(id, load.error);
        // Present but invalid: not absent, and not retryable.
        if (load.status === 'corrupt') throw new GoalCorruptOwnershipRecordError(id);
        return isGoalNamedRun(load, id) ? state : null;
      }
      return state;
    },
    start: async (...args: unknown[]) => {
      const options = args[2] as { readonly id?: string } | undefined;
      const id = options?.id;
      if (id !== undefined && isController(id) && !(await ownedController(id))) refuse(id);
      return (engine.start as (...a: unknown[]) => unknown)(...args);
    },
    getFinalizerStatus: async (id: string) =>
      isController(id) && !(await ownedController(id)) ? null : engine.getFinalizerStatus(id),
  };
  for (const method of ['signal', 'cancel', 'resume'] as const) {
    overrides[method] = async (id: string, ...rest: unknown[]) => {
      if (isController(id) && !(await ownedController(id))) refuse(id);
      return (engine[method] as (...a: unknown[]) => unknown)(id, ...rest);
    };
  }

  return new Proxy(engine, {
    get(target, property) {
      if (typeof property === 'string' && property in overrides) return overrides[property];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
}

/**
 * `cancelRun` that stops only a run a goal marked as its own. A run at the id
 * that is not the goal's is left alone and reported `not-found`, which is what
 * the goal's own view of the id says.
 */
export function createOwnedRunCanceller(
  cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>,
  readRunRecord: RunRecordReader,
): (runId: string) => Promise<CancelDurableRunOutcome> {
  return async (runId) => {
    const load = await readRunRecord(runId);
    // Unknown is not foreign: report a retryable failure and cancel nothing.
    if (load.status === 'read-error') {
      return { status: 'failed', error: new GoalOwnershipUnknownError(runId, load.error) };
    }
    if (load.status === 'corrupt') {
      return { status: 'failed', error: new GoalCorruptOwnershipRecordError(runId) };
    }
    // A claim with no workflow is cancelled too: that is the goal's own start
    // that died, and cancelling a run that never existed is a no-op.
    return isGoalNamedRun(load, runId) ? cancelRun(runId) : { status: 'not-found' };
  };
}
