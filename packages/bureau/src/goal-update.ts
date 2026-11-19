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
 *   policy a retry's turn is the validator's feedback alone, because the transcript holds the
 *   prompt, so an edit sets `objective.promptPending` and the start of the next attempt takes it in
 *   its own write (`consumePromptEdit`), recording its index in `objective.promptRevisedAtAttempt`
 *   from the record it seats from. That one retry is turned with the new prompt and then the
 *   feedback (`goalAttemptInput`); an edit landing after a start's write waits for the attempt after.
 * - The validator is read when a check begins. A check already running finishes with the validator
 *   it began with, and every check recorded keeps the identity it ran against (its validation
 *   carries it). An attempt still running when the validator changes is checked against the new one.
 * - The attempt limit is read when the controller decides whether a failed attempt is retried. The
 *   store allows a change only where that decision reads the same under both limits (see
 *   `evaluateConfigurationUpdate` in `goal-store.ts`).
 * - The agent is the one the attempts opened from now on run as. Each attempt carries the agent it
 *   was opened under (`DurableGoalAttempt.agentName`, written for every attempt already opened in
 *   the same write that changes the goal's agent), and the ownership, fence and session checks
 *   read that agent through `attemptAgentName`, never the goal's current one. It changes only
 *   while an attempt is in flight: a controller starting an attempt reads the agent and claims the
 *   attempt's run before the record says the attempt exists, so between attempts an agent could
 *   change under a start already under way (`agent-between-attempts`).
 *
 * Everything that does not depend on the record as stored now (the validator is registered and
 * supplies what the goal requires, the limit is one the goal rules accept) is checked here, before
 * the write. What does depend on it is decided inside the write, against the record it replaces.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  decideDeterminismRequirement,
  GoalConfigurationError,
  type JSONValue,
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
import type { ValidatorFileDefinition } from './validator-file';
import {
  describeConfigurationRefusal,
  type GoalConfigurationIssue,
  parseValidatorConfiguration,
} from './goal-validator-configuration';

/** What an update reads and writes. */
export interface GoalUpdateDependencies {
  readonly store: Pick<GoalStore, 'updateConfiguration'>;
  /** Resolves a new validator, and says what it promises about determinism. */
  readonly catalog: Pick<GoalValidatorCatalog, 'resolve'>;
  /** `undefined` when the catalog has no agent by this name, or a person disabled it (COR-2429). */
  readonly planAgent: (
    agentName: string,
  ) =>
    | { readonly durable: boolean; readonly agentVersion: string }
    | undefined
    | Promise<{ readonly durable: boolean; readonly agentVersion: string } | undefined>;
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
  'agent-between-attempts': {
    code: 'agent-between-attempts',
    reason:
      'No attempt is in flight, and the controller may already have read the agent it is about to claim the next attempt’s run for, so the agent cannot change until an attempt is running.',
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
  issues?: readonly GoalConfigurationIssue[],
): Rejection {
  return {
    outcome: 'rejected',
    code,
    reason,
    ...(availableVersions === undefined ? {} : { availableVersions }),
    ...(issues === undefined ? {} : { issues }),
  };
}

/** What a request that may be written needs beyond what it names. */
interface PreparedUpdate {
  /** The validator's configuration as its schema parsed it (COR-2117); `undefined` when the request names none. */
  readonly validatorConfiguration: JSONValue | undefined;
  /** The definition of the owner-defined validator the request changes the goal to (COR-2119). */
  readonly validatorDefinition: ValidatorFileDefinition | undefined;
}

/**
 * Why `request` cannot change `record`, judged on what does not depend on the record as stored at
 * the write: the fields named, their values, and what the Bureau holds now. Otherwise, what the
 * write needs beyond the request ({@link PreparedUpdate}).
 */
async function refusalOf(
  dependencies: Pick<GoalUpdateDependencies, 'catalog' | 'planAgent'>,
  record: GoalState,
  request: BureauGoalUpdateRequest,
): Promise<Rejection | PreparedUpdate> {
  let validatorConfiguration: JSONValue | undefined;
  let validatorDefinition: ValidatorFileDefinition | undefined;
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
  // A new agent must be one the catalog has and that can run durably, as `create` requires; whether
  // an attempt is in flight is decided inside the write (`agent-between-attempts`), against the
  // record it would replace.
  if (agentName !== undefined && agentName !== record.objective.agentName) {
    const plan = await dependencies.planAgent(agentName);
    if (plan === undefined) {
      return rejected('agent-not-found', `Unknown agent "${agentName}".`);
    }
    if (!plan.durable) {
      return rejected(
        'agent-not-durable',
        `Agent "${agentName}" cannot run durably, so it cannot run a goal attempt.`,
      );
    }
  }
  // A validator that is not the goal's, or the goal's own with a configuration named (COR-2117),
  // is resolved and its configuration parsed by the rules `create` uses; the schema of the validator
  // named decides whether naming no configuration is allowed.
  const validatorChanged =
    validator !== undefined &&
    (validator.name !== record.validator.name || validator.version !== record.validator.version);
  if (validator !== undefined && (validatorChanged || validator.configuration !== undefined)) {
    // The goal's own copy answers for the validator it already has (COR-2119); another is the
    // catalog's, and an owner-defined one is copied into the record when it is written.
    const resolution = dependencies.catalog.resolve(
      validator,
      validatorChanged ? undefined : record.validatorDefinition,
    );
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
    if (validatorChanged) {
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
    const parsed = parseValidatorConfiguration(resolution.entry.validator, validator.configuration);
    if (!parsed.ok) {
      return rejected(
        'invalid-configuration',
        describeConfigurationRefusal(validator, parsed.issues),
        undefined,
        parsed.issues,
      );
    }
    validatorConfiguration = parsed.value;
    validatorDefinition = validatorChanged ? resolution.entry.definition : undefined;
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
  return { validatorConfiguration, validatorDefinition };
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
  const prepared = await refusalOf(dependencies, record, request);
  if ('outcome' in prepared) return prepared;
  const patch: GoalConfigurationPatch = {
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
    ...(request.validator === undefined
      ? {}
      : { validator: { name: request.validator.name, version: request.validator.version } }),
    ...(prepared.validatorConfiguration === undefined
      ? {}
      : { validatorConfiguration: prepared.validatorConfiguration }),
    ...(prepared.validatorDefinition === undefined
      ? {}
      : { validatorDefinition: prepared.validatorDefinition }),
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
