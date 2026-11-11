/**
 * COR-2017 — `bureau.goals.update`: changes a goal's prompt, validator, or attempt limit for the
 * attempts it has not yet made.
 *
 * The record is the goal's configuration, and the controller re-reads it at every decision point,
 * so an update is one compare-and-swap on the record and nothing else: no signal, no workflow, no
 * attempt is started. What it can and cannot reach follows from when each field is read.
 *
 * - The prompt is read when an attempt is seated, so an attempt in flight keeps the one it started
 *   with, and the next attempt the goal opens has the new one. Under the `continue` conversation
 *   policy a retry's turn is the validator's feedback when there is some, so the new prompt reaches
 *   a retry only when the feedback is absent.
 * - The validator is read when a check begins. A check already running finishes with the validator
 *   it began with, and every check recorded keeps the identity it ran against (its validation
 *   carries it). An attempt still running when the validator changes is checked against the new one.
 * - The attempt limit is read when the controller decides whether a failed attempt is retried. The
 *   store allows a change only where that decision reads the same under both limits (see
 *   `evaluateConfigurationUpdate` in `goal-store.ts`).
 * - The agent cannot change at all, and is accepted only as it is. The goal's sessions and every
 *   attempt's run belong to the agent they started with, and each ownership check compares them with
 *   the agent the record names. Not even before the first attempt is recorded: the controller starts
 *   with the goal, and its start reads the agent and claims the first attempt's run before the record
 *   says that attempt exists.
 *
 * Everything that does not depend on the record as stored now (the validator is registered and
 * supplies what the goal requires, the limit is one the goal rules accept) is checked here, before
 * the write. What does depend on it is decided inside the write, against the record it replaces.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  decideDeterminismRequirement,
  GoalConfigurationError,
  validateBudget,
} from '@lostgradient/operative';

import {
  GOAL_MAXIMUM_ATTEMPTS,
  GOAL_OBJECTIVE_MAXIMUM_BYTES,
  GoalObjectiveTooLargeError,
  GoalRunIdError,
  type GoalState,
  objectiveByteLength,
  validateGoalRunId,
} from './goal-state';
import type { GoalConfigurationPatch, GoalConfigurationRejection, GoalStore } from './goal-store';
import type {
  BureauGoalUpdateOutcome,
  BureauGoalUpdateRejectionCode,
  BureauGoalUpdateRequest,
} from './goal-types';
import type { GoalValidatorCatalog } from './goal-validator-catalog';

/** What an update reads and writes. */
export interface GoalUpdateDependencies {
  readonly store: Pick<GoalStore, 'updateConfiguration'>;
  /** Resolves a new validator, and says what it promises about determinism. */
  readonly catalog: Pick<GoalValidatorCatalog, 'resolve'>;
  readonly clock: Pick<RuntimeServices['clock'], 'nowISO'>;
}

/** What each refusal the store decides is answered with. */
const STORE_REFUSALS: Readonly<
  Record<
    GoalConfigurationRejection,
    { readonly code: BureauGoalUpdateRejectionCode; readonly reason: string }
  >
> = {
  terminal: { code: 'terminal', reason: 'The goal has ended, so there is nothing left to change.' },
  'cancellation-requested': {
    code: 'cancellation-requested',
    reason: 'A cancellation is recorded, so the goal is ending.',
  },
  'agent-fixed': {
    code: 'agent-fixed',
    reason:
      'A goal’s sessions and runs belong to the agent they started with, and its first attempt is claimed when the goal is created, so the agent cannot change.',
  },
  'attempt-limit-fixed': {
    code: 'attempt-limit-fixed',
    reason:
      'The goal’s last allowed attempt is in flight, so its attempt limit cannot change until that attempt is decided.',
  },
  'attempt-limit-too-low': {
    code: 'attempt-limit-too-low',
    reason: 'The attempt limit must leave room for an attempt beyond those the goal has opened.',
  },
  'invalid-record': {
    code: 'invalid-configuration',
    reason: 'The goal with this change would not be a valid goal record.',
  },
};

type Rejection = Extract<BureauGoalUpdateOutcome, { outcome: 'rejected' }>;

function rejected(
  code: BureauGoalUpdateRejectionCode,
  reason: string,
  availableVersions?: readonly string[],
): Rejection {
  return {
    outcome: 'rejected',
    code,
    reason,
    ...(availableVersions === undefined ? {} : { availableVersions }),
  };
}

/**
 * Why `request` cannot change `record`, judged on what does not depend on the record as stored at
 * the write: the fields named, their values, and what the Bureau holds now. `undefined` when it may
 * be written.
 */
function refusalOf(
  dependencies: Pick<GoalUpdateDependencies, 'catalog'>,
  record: GoalState,
  request: BureauGoalUpdateRequest,
): Rejection | undefined {
  const { prompt, agentName, validator, maximumAttempts } = request;
  if (
    prompt === undefined &&
    agentName === undefined &&
    validator === undefined &&
    maximumAttempts === undefined
  ) {
    return rejected(
      'invalid-configuration',
      'An update must name at least one of prompt, agentName, validator, and maximumAttempts.',
    );
  }
  if (prompt !== undefined) {
    if (prompt.length === 0) {
      return rejected('invalid-configuration', 'The goal prompt must be non-empty text.');
    }
    const bytes = objectiveByteLength({ ...record.objective, prompt });
    if (bytes > GOAL_OBJECTIVE_MAXIMUM_BYTES) {
      return rejected('objective-too-large', new GoalObjectiveTooLargeError(bytes).message);
    }
  }
  // Another agent is refused inside the write (`agent-fixed`), against the record it would replace.
  if (
    validator !== undefined &&
    (validator.name !== record.validator.name || validator.version !== record.validator.version)
  ) {
    const resolution = dependencies.catalog.resolve(validator);
    if (!resolution.ok) {
      return resolution.reason === 'missing'
        ? rejected(
            'validator-missing',
            `The validator "${validator.name}@${validator.version}" is not registered.`,
          )
        : rejected(
            'validator-version-mismatch',
            `The validator "${validator.name}" has no version "${validator.version}".`,
            resolution.availableVersions,
          );
    }
    const unsupported = decideDeterminismRequirement(
      record.requireDeterministicValidation,
      resolution.entry.descriptor.determinism,
    );
    if (unsupported?.kind === 'fail') {
      return rejected(
        'unsupported-validation',
        `The goal requires deterministic validation, and the validator "${validator.name}@${validator.version}" does not declare it.`,
      );
    }
  }
  if (maximumAttempts !== undefined && maximumAttempts !== record.bounds.maximumAttempts) {
    try {
      validateBudget({ ...record.bounds, maximumAttempts });
      if (maximumAttempts > GOAL_MAXIMUM_ATTEMPTS) {
        throw new GoalConfigurationError(
          'invalid-maximum-attempts',
          `GoalBudget.maximumAttempts must be at most ${GOAL_MAXIMUM_ATTEMPTS} for a durable goal, so its audit log stays bounded.`,
        );
      }
      // A higher limit derives the identifiers of a later attempt, which must still fit.
      validateGoalRunId(record.goalRunId, maximumAttempts);
    } catch (error) {
      if (error instanceof GoalConfigurationError) {
        return rejected('invalid-configuration', `${error.reason}: ${error.message}`);
      }
      if (error instanceof GoalRunIdError) return rejected('invalid-configuration', error.message);
      throw error;
    }
  }
  return undefined;
}

/**
 * Performs an update the caller has already authorized against `record`. `expectedRevision` is
 * compared first against `record`, so a stale token is refused whatever else is true of the goal,
 * and again inside the store's compare-and-swap, so a write that lands between the two is caught.
 */
export async function updateGoal(
  dependencies: GoalUpdateDependencies,
  record: GoalState,
  request: BureauGoalUpdateRequest,
): Promise<BureauGoalUpdateOutcome> {
  if (record.revision !== request.expectedRevision) {
    return { outcome: 'stale-revision', goal: record };
  }
  const refusal = refusalOf(dependencies, record, request);
  if (refusal !== undefined) return refusal;
  const patch: GoalConfigurationPatch = {
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
    ...(request.validator === undefined
      ? {}
      : { validator: { name: request.validator.name, version: request.validator.version } }),
    ...(request.maximumAttempts === undefined ? {} : { maximumAttempts: request.maximumAttempts }),
  };
  const written = await dependencies.store.updateConfiguration(
    record.goalRunId,
    patch,
    dependencies.clock.nowISO(),
    request.expectedRevision,
  );
  switch (written.status) {
    case 'updated':
      return { outcome: 'updated', goal: written.record };
    case 'unchanged':
      return { outcome: 'unchanged', goal: written.record };
    case 'revision-mismatch':
      return { outcome: 'stale-revision', goal: written.record };
    case 'stale':
      return { outcome: 'contended', goal: written.record };
    case 'rejected': {
      const { code, reason } = STORE_REFUSALS[written.reason];
      return rejected(code, reason);
    }
    case 'corrupt':
      // The record decoded a moment ago and no longer does; only a caller who may see every goal
      // is told so.
      return request.principal === undefined
        ? { outcome: 'record-unreadable' }
        : { outcome: 'not-found' };
    case 'missing':
      return { outcome: 'not-found' };
  }
}
