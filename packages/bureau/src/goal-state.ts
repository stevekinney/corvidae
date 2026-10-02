/**
 * COR-851 — the durable record of one Bureau goal run.
 *
 * `GoalState` is the inspectable projection every controller transition
 * commits to. It holds plain JSON only: the objective (an agent *name* and
 * its prompt, never a closure), the validator's pinned identity, the
 * conversation policy, the bounds, one record per attempt, the aggregate
 * usage, the last committed transition, and the two pieces of control-plane
 * state — the cancellation marker and the controller restart count.
 *
 * Two counters keep concurrent writers honest. `revision` advances on EVERY
 * successful write (a controller transition or a control-plane write) and is
 * the compare-and-swap token. `transitionSeq` advances only on a controller
 * state-machine transition, so a replayed workflow re-issues byte-identical
 * commits and the store can recognise them.
 *
 * The decoder is hand-written and fail-closed, like `isChildRecord` in
 * `child-topology-store.ts`: a record that does not decode to its exact shape
 * (including the terminal-status/terminal-reason pairing the COR-638 table
 * requires) is treated as absent and reported, never trusted as a partial
 * value.
 */

import {
  type FinishReason,
  freshAttemptHandoffArtifactSchema,
  type GoalBudget,
  GoalConfigurationError,
  type GoalConversationPolicy,
  type GoalIdentity,
  type GoalRetryPolicy,
  type GoalRunStatus,
  type GoalRunTerminalReason,
  type JsonValue,
  type ProjectedValidatorError,
  type ProjectedValidatorOutcome,
  TERMINAL_STATUS_BY_REASON,
  TERMINAL_STATUSES,
  validateBudget,
  validateConversationPolicy,
  validateRetryPolicy,
  VALIDATOR_ERROR_KINDS,
  type ValidatorIdentity,
} from '@lostgradient/operative';

// ---------------------------------------------------------------------------
// Caps, keys, and identifiers
// ---------------------------------------------------------------------------

export const GOAL_STATE_SCHEMA_VERSION = 1 as const;

/**
 * The objective is stored inline. `prompt` plus `instructions` (UTF-8 bytes)
 * above this ceiling is rejected up front with {@link GoalObjectiveTooLargeError}
 * rather than written and later truncated.
 */
export const GOAL_OBJECTIVE_MAXIMUM_BYTES = 65_536;

/**
 * One attempt's validation outcome is stored inline too. `boundValidationOutcome`
 * brings an over-cap outcome under this ceiling; the store refuses anything
 * that is still over it.
 */
export const GOAL_VALIDATION_MAXIMUM_BYTES = 65_536;

/** Never a Weft-reserved prefix (see `WEFT_RESERVED_KEY_PREFIXES`). */
export const GOAL_RECORD_KEY_PREFIX = 'bureau-goal:record:';

// `encodeURIComponent` escapes `:`, so identifiers containing separators
// cannot collide with another record's key.
export function goalRecordKey(goalRunId: string): string {
  return `${GOAL_RECORD_KEY_PREFIX}${encodeURIComponent(goalRunId)}`;
}

/** The Weft workflow that owns this goal; an explicit id makes a duplicate start refusable. */
export const goalWorkflowId = (goalRunId: string): string => `goal:${goalRunId}`;
export const goalTransitionId = (goalRunId: string, seq: number): string => `${goalRunId}:t${seq}`;
export const goalAttemptId = (goalRunId: string, attemptIndex: number): string =>
  `${goalRunId}:a${attemptIndex}`;
/** Deterministic, so a restart that re-starts attempt N finds attempt N's run, never N+1's. */
export const goalAttemptRunId = (goalRunId: string, attemptIndex: number): string =>
  `goal-${goalRunId}-a${attemptIndex}`;
/** The first committed decision for an attempt wins; a re-executed validator cannot add a second. */
export const goalDecisionId = (attemptId: string): string => `${attemptId}:decision`;

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export interface GoalObjective {
  /** The agent is resolved by NAME from the Bureau catalog on every use. */
  readonly agentName: string;
  readonly prompt: string;
  readonly instructions?: string | undefined;
  readonly baselineSessionId?: string | undefined;
}

export interface DurableGoalAttemptUsage {
  readonly steps: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
}

/** The aggregate: `costUsd` stays absent until some attempt reports a cost. */
export interface DurableGoalUsage {
  readonly attempts: number;
  readonly steps: number;
  readonly tokens: number;
  readonly costUsd?: number | undefined;
  readonly durationMs: number;
}

export type DurableGoalAttemptStatus = 'running' | 'evaluating' | 'passed' | 'failed' | 'aborted';

export interface DurableGoalValidation {
  readonly identity: ValidatorIdentity;
  readonly startedAt: string;
  readonly completedAt: string;
  /** JSON-safe: `ValidatorError.cause` and evidence `detail` are already projected. */
  readonly outcome: ProjectedValidatorOutcome;
  readonly decisionId: string;
}

export interface DurableGoalAttempt {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly runId: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly finishReason?: FinishReason | undefined;
  readonly validation?: DurableGoalValidation | undefined;
  readonly feedback?: string | undefined;
  readonly usage: DurableGoalAttemptUsage;
  readonly status: DurableGoalAttemptStatus;
}

/** What is in flight right now; cleared when its result commits. */
export type ActiveGoalWork =
  | {
      readonly kind: 'attempt';
      readonly attemptId: string;
      readonly runId: string;
      readonly startedAt: string;
    }
  | {
      readonly kind: 'validation';
      readonly attemptId: string;
      readonly validator: ValidatorIdentity;
      readonly startedAt: string;
    };

export interface GoalTransitionRecord {
  /** Equals the record's `transitionSeq`. */
  readonly seq: number;
  readonly transitionId: string;
  readonly from: GoalRunStatus;
  readonly to: GoalRunStatus;
  readonly at: string;
  readonly cause: string;
}

/**
 * An operator asked this goal to stop. Authoritative: the controller re-reads
 * the record at each decision point, and the cancel signal is only an
 * optimisation. Written by the control plane, never by a controller
 * transition.
 */
export interface GoalCancellationMarker {
  readonly requestedAt: string;
  readonly principal?: string | undefined;
  readonly reason?: string | undefined;
}

export interface GoalState {
  readonly schemaVersion: typeof GOAL_STATE_SCHEMA_VERSION;
  readonly goalRunId: string;
  readonly workflowId: string;
  /** Starts at `1`; every accepted write advances it by exactly one. */
  readonly revision: number;
  /** Starts at `0`; advances only on a controller transition. */
  readonly transitionSeq: number;
  readonly identity: GoalIdentity;
  readonly objective: GoalObjective;
  /** Pinned at create time; resolved from the validator catalog on every use. */
  readonly validator: ValidatorIdentity;
  readonly requireDeterministicValidation: boolean;
  readonly validatorTimeoutMs?: number | undefined;
  readonly conversationPolicy: GoalConversationPolicy;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  readonly bounds: GoalBudget;
  /** The principal that owns this goal. */
  readonly principal?: string | undefined;
  readonly status: GoalRunStatus;
  /** Present exactly when `status` is terminal, and always mapped to that status. */
  readonly terminalReason?: GoalRunTerminalReason | undefined;
  readonly failureDetail?: string | undefined;
  readonly currentTransition: GoalTransitionRecord;
  readonly attempts: readonly DurableGoalAttempt[];
  readonly usage: DurableGoalUsage;
  readonly active?: ActiveGoalWork | undefined;
  readonly cancellation?: GoalCancellationMarker | undefined;
  /** How many times boot recovery restarted a controller that ended abnormally. */
  readonly controllerRestarts: number;
  /** Set once by `close()`; terminal records only. */
  readonly closedAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The objective's `prompt` plus `instructions` exceeds {@link GOAL_OBJECTIVE_MAXIMUM_BYTES}. */
export class GoalObjectiveTooLargeError extends Error {
  readonly byteLength: number;
  readonly maximumBytes: number;

  constructor(byteLength: number, maximumBytes: number = GOAL_OBJECTIVE_MAXIMUM_BYTES) {
    super(
      `Bureau goal objective is ${byteLength} bytes; the inline limit is ${maximumBytes} bytes.`,
    );
    this.name = 'GoalObjectiveTooLargeError';
    this.byteLength = byteLength;
    this.maximumBytes = maximumBytes;
  }
}

/** A `GoalState` the store was asked to write does not decode to its exact shape. */
export class InvalidGoalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGoalStateError';
  }
}

// ---------------------------------------------------------------------------
// Size helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function objectiveByteLength(objective: GoalObjective): number {
  return utf8ByteLength(objective.prompt) + utf8ByteLength(objective.instructions ?? '');
}

export function validationByteLength(validation: DurableGoalValidation): number {
  return utf8ByteLength(JSON.stringify(validation.outcome));
}

const TEXT_MAXIMUM_CHARACTERS = 4096;

const truncateText = (text: string): string =>
  text.length <= TEXT_MAXIMUM_CHARACTERS ? text : `${text.slice(0, TEXT_MAXIMUM_CHARACTERS)}…`;

function truncationMarker(value: JsonValue): JsonValue {
  return { truncated: true, originalByteLength: utf8ByteLength(JSON.stringify(value)) };
}

function boundError(error: ProjectedValidatorError): ProjectedValidatorError {
  const { cause, ...rest } = error;
  return {
    ...rest,
    message: truncateText(error.message),
    ...(cause === undefined ? {} : { cause: truncationMarker(cause) }),
  };
}

/**
 * Brings a validator outcome under `maximumBytes` deterministically. An
 * outcome already under the ceiling is returned untouched. Otherwise every
 * evidence `detail` and `ValidatorError.cause` is replaced by a
 * `{ truncated, originalByteLength }` marker and free-text fields are cut to a
 * fixed length. The verdict itself (its `kind`, `retryable`, `source`s) never
 * changes, so the decision a bounded outcome produces equals the unbounded one.
 */
export function boundValidationOutcome(
  outcome: ProjectedValidatorOutcome,
  maximumBytes: number = GOAL_VALIDATION_MAXIMUM_BYTES,
): ProjectedValidatorOutcome {
  if (utf8ByteLength(JSON.stringify(outcome)) <= maximumBytes) return outcome;
  const evidence = (items: readonly { source: string; detail: JsonValue }[]) =>
    items.map((item) => ({ source: item.source, detail: truncationMarker(item.detail) }));
  switch (outcome.kind) {
    case 'pass':
      return { kind: 'pass', evidence: evidence(outcome.evidence) };
    case 'fail':
      return {
        kind: 'fail',
        feedback: truncateText(outcome.feedback),
        evidence: evidence(outcome.evidence),
        retryable: outcome.retryable,
      };
    case 'error':
      return { kind: 'error', error: boundError(outcome.error) };
    case 'unavailable':
      return {
        kind: 'unavailable',
        error: boundError(outcome.error),
        reason: truncateText(outcome.reason),
      };
    case 'canceled':
      return outcome;
    case 'indeterminate':
      return { kind: 'indeterminate', reason: truncateText(outcome.reason) };
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

type PlainRecord = Record<string, unknown>;

const isPlainRecord = (value: unknown): value is PlainRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmptyString = (value: unknown): value is string => isString(value) && value.length > 0;
const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isOptionalNonNegativeNumber = (value: unknown): boolean =>
  value === undefined || isNonNegativeNumber(value);

const hasExactKeys = (value: PlainRecord, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const MAXIMUM_JSON_DEPTH = 64;

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAXIMUM_JSON_DEPTH) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

const GOAL_STATUSES: Readonly<Record<GoalRunStatus, true>> = {
  pending: true,
  running: true,
  evaluating: true,
  retrying: true,
  succeeded: true,
  exhausted: true,
  failed: true,
  canceled: true,
};

const FINISH_REASONS: Readonly<Record<FinishReason, true>> = {
  'stop-condition': true,
  'maximum-steps': true,
  aborted: true,
  error: true,
  'elicitation-denied': true,
  'budget-exceeded': true,
  tripwire: true,
};

const ATTEMPT_STATUSES: Readonly<Record<DurableGoalAttemptStatus, true>> = {
  running: true,
  evaluating: true,
  passed: true,
  failed: true,
  aborted: true,
};

const hasKey = (table: object, key: unknown): boolean => isString(key) && Object.hasOwn(table, key);

export const isGoalRunStatus = (value: unknown): value is GoalRunStatus =>
  hasKey(GOAL_STATUSES, value);

/** Terminal statuses have no outgoing edge in COR-638's transition table. */
export const isTerminalGoalStatus = (status: GoalRunStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

export const isGoalRunTerminalReason = (value: unknown): value is GoalRunTerminalReason =>
  hasKey(TERMINAL_STATUS_BY_REASON, value);

const isValidatorIdentity = (value: unknown): value is ValidatorIdentity =>
  isPlainRecord(value) &&
  hasExactKeys(value, ['name', 'version']) &&
  isNonEmptyString(value['name']) &&
  isNonEmptyString(value['version']);

function isProjectedError(value: unknown): value is ProjectedValidatorError {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['kind', 'code', 'message', 'cause'])) {
    return false;
  }
  return (
    VALIDATOR_ERROR_KINDS.some((kind) => kind === value['kind']) &&
    isString(value['code']) &&
    isString(value['message']) &&
    (value['cause'] === undefined || isJsonValue(value['cause']))
  );
}

function isProjectedEvidence(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['source', 'detail']) &&
    isString(value['source']) &&
    isJsonValue(value['detail'])
  );
}

const isEvidenceList = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isProjectedEvidence);

type OutcomeCheck = (value: PlainRecord) => boolean;

const OUTCOME_CHECKS: Readonly<Record<ProjectedValidatorOutcome['kind'], OutcomeCheck>> = {
  pass: (value) => hasExactKeys(value, ['kind', 'evidence']) && isEvidenceList(value['evidence']),
  fail: (value) =>
    hasExactKeys(value, ['kind', 'feedback', 'evidence', 'retryable']) &&
    isString(value['feedback']) &&
    isEvidenceList(value['evidence']) &&
    typeof value['retryable'] === 'boolean',
  error: (value) => hasExactKeys(value, ['kind', 'error']) && isProjectedError(value['error']),
  unavailable: (value) =>
    hasExactKeys(value, ['kind', 'error', 'reason']) &&
    isProjectedError(value['error']) &&
    isString(value['reason']),
  canceled: (value) => hasExactKeys(value, ['kind']),
  indeterminate: (value) => hasExactKeys(value, ['kind', 'reason']) && isString(value['reason']),
};

export function isProjectedValidatorOutcome(value: unknown): value is ProjectedValidatorOutcome {
  if (!isPlainRecord(value)) return false;
  const kind = value['kind'];
  if (!isString(kind) || !Object.hasOwn(OUTCOME_CHECKS, kind)) return false;
  return OUTCOME_CHECKS[kind as ProjectedValidatorOutcome['kind']](value);
}

function isValidation(value: unknown): value is DurableGoalValidation {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['identity', 'startedAt', 'completedAt', 'outcome', 'decisionId']) &&
    isValidatorIdentity(value['identity']) &&
    isNonEmptyString(value['startedAt']) &&
    isNonEmptyString(value['completedAt']) &&
    isProjectedValidatorOutcome(value['outcome']) &&
    isNonEmptyString(value['decisionId'])
  );
}

function isAttemptUsage(value: unknown): value is DurableGoalAttemptUsage {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['steps', 'tokens', 'costUsd']) &&
    isNonNegativeNumber(value['steps']) &&
    isNonNegativeNumber(value['tokens']) &&
    isOptionalNonNegativeNumber(value['costUsd'])
  );
}

const ATTEMPT_KEYS = [
  'attemptId',
  'attemptIndex',
  'runId',
  'sessionId',
  'startedAt',
  'completedAt',
  'finishReason',
  'validation',
  'feedback',
  'usage',
  'status',
] as const;

export function isDurableGoalAttempt(value: unknown): value is DurableGoalAttempt {
  if (!isPlainRecord(value) || !hasExactKeys(value, ATTEMPT_KEYS)) return false;
  return (
    isNonEmptyString(value['attemptId']) &&
    isNonNegativeInteger(value['attemptIndex']) &&
    isNonEmptyString(value['runId']) &&
    isNonEmptyString(value['sessionId']) &&
    isNonEmptyString(value['startedAt']) &&
    isOptionalString(value['completedAt']) &&
    (value['finishReason'] === undefined || hasKey(FINISH_REASONS, value['finishReason'])) &&
    (value['validation'] === undefined || isValidation(value['validation'])) &&
    isOptionalString(value['feedback']) &&
    isAttemptUsage(value['usage']) &&
    hasKey(ATTEMPT_STATUSES, value['status'])
  );
}

function isActiveWork(value: unknown): value is ActiveGoalWork {
  if (!isPlainRecord(value)) return false;
  if (value['kind'] === 'attempt') {
    return (
      hasExactKeys(value, ['kind', 'attemptId', 'runId', 'startedAt']) &&
      isNonEmptyString(value['attemptId']) &&
      isNonEmptyString(value['runId']) &&
      isNonEmptyString(value['startedAt'])
    );
  }
  return (
    value['kind'] === 'validation' &&
    hasExactKeys(value, ['kind', 'attemptId', 'validator', 'startedAt']) &&
    isNonEmptyString(value['attemptId']) &&
    isValidatorIdentity(value['validator']) &&
    isNonEmptyString(value['startedAt'])
  );
}

function isTransitionRecord(value: unknown): value is GoalTransitionRecord {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['seq', 'transitionId', 'from', 'to', 'at', 'cause']) &&
    isNonNegativeInteger(value['seq']) &&
    isNonEmptyString(value['transitionId']) &&
    isGoalRunStatus(value['from']) &&
    isGoalRunStatus(value['to']) &&
    isNonEmptyString(value['at']) &&
    isString(value['cause'])
  );
}

function isCancellationMarker(value: unknown): value is GoalCancellationMarker {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['requestedAt', 'principal', 'reason']) &&
    isNonEmptyString(value['requestedAt']) &&
    isOptionalString(value['principal']) &&
    isOptionalString(value['reason'])
  );
}

function isIdentity(value: unknown): value is GoalIdentity {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['name', 'version']) &&
    isNonEmptyString(value['name']) &&
    isNonEmptyString(value['version'])
  );
}

function isObjective(value: unknown): value is GoalObjective {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['agentName', 'prompt', 'instructions', 'baselineSessionId']) &&
    isNonEmptyString(value['agentName']) &&
    isString(value['prompt']) &&
    isOptionalString(value['instructions']) &&
    isOptionalString(value['baselineSessionId']) &&
    objectiveByteLength(value as unknown as GoalObjective) <= GOAL_OBJECTIVE_MAXIMUM_BYTES
  );
}

function isUsage(value: unknown): value is DurableGoalUsage {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['attempts', 'steps', 'tokens', 'costUsd', 'durationMs']) &&
    isNonNegativeInteger(value['attempts']) &&
    isNonNegativeNumber(value['steps']) &&
    isNonNegativeNumber(value['tokens']) &&
    isOptionalNonNegativeNumber(value['costUsd']) &&
    isNonNegativeNumber(value['durationMs'])
  );
}

/** Reuses COR-638's own validators, so the durable record accepts exactly what `startGoal` does. */
function passes(check: () => void): boolean {
  try {
    check();
    return true;
  } catch (error) {
    if (error instanceof GoalConfigurationError) return false;
    throw error;
  }
}

function isBounds(value: unknown): value is GoalBudget {
  if (!isPlainRecord(value)) return false;
  const keys = [
    'maximumAttempts',
    'maximumTotalDurationMs',
    'maximumTotalSteps',
    'maximumTotalTokens',
    'maximumTotalCostUsd',
  ];
  return hasExactKeys(value, keys) && passes(() => validateBudget(value as unknown as GoalBudget));
}

function isRetryPolicy(value: unknown): value is GoalRetryPolicy {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['retryOn']) &&
    passes(() => validateRetryPolicy(value as unknown as GoalRetryPolicy))
  );
}

function isConversationPolicy(value: unknown, instructions: string | undefined): boolean {
  if (!isPlainRecord(value)) return false;
  if (value['kind'] === 'continue') return hasExactKeys(value, ['kind']);
  if (value['kind'] === 'fork-from-baseline') {
    return (
      hasExactKeys(value, ['kind', 'throughRun']) &&
      passes(() => validateConversationPolicy(value, instructions))
    );
  }
  return (
    value['kind'] === 'fresh-from-artifact' &&
    hasExactKeys(value, ['kind', 'artifact']) &&
    freshAttemptHandoffArtifactSchema.safeParse(value['artifact']).success &&
    passes(() => validateConversationPolicy(value, instructions))
  );
}

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'goalRunId',
  'workflowId',
  'revision',
  'transitionSeq',
  'identity',
  'objective',
  'validator',
  'requireDeterministicValidation',
  'validatorTimeoutMs',
  'conversationPolicy',
  'retryPolicy',
  'bounds',
  'principal',
  'status',
  'terminalReason',
  'failureDetail',
  'currentTransition',
  'attempts',
  'usage',
  'active',
  'cancellation',
  'controllerRestarts',
  'closedAt',
  'createdAt',
  'updatedAt',
];

function isTerminalPairing(value: PlainRecord): boolean {
  const status = value['status'] as GoalRunStatus;
  const reason = value['terminalReason'];
  if (!isTerminalGoalStatus(status)) return reason === undefined && value['closedAt'] === undefined;
  return isGoalRunTerminalReason(reason) && TERMINAL_STATUS_BY_REASON[reason] === status;
}

function isConsistent(value: PlainRecord): boolean {
  const transition = value['currentTransition'] as GoalTransitionRecord;
  const attempts = value['attempts'] as readonly DurableGoalAttempt[];
  return (
    value['workflowId'] === goalWorkflowId(value['goalRunId'] as string) &&
    transition.seq === value['transitionSeq'] &&
    transition.to === value['status'] &&
    transition.transitionId === goalTransitionId(value['goalRunId'] as string, transition.seq) &&
    attempts.every((attempt, index) => attempt.attemptIndex === index) &&
    isTerminalPairing(value)
  );
}

function isShape(value: PlainRecord): boolean {
  return (
    value['schemaVersion'] === GOAL_STATE_SCHEMA_VERSION &&
    isNonEmptyString(value['goalRunId']) &&
    isNonEmptyString(value['workflowId']) &&
    typeof value['revision'] === 'number' &&
    Number.isInteger(value['revision']) &&
    value['revision'] >= 1 &&
    isNonNegativeInteger(value['transitionSeq']) &&
    isIdentity(value['identity']) &&
    isObjective(value['objective']) &&
    isValidatorIdentity(value['validator']) &&
    typeof value['requireDeterministicValidation'] === 'boolean' &&
    (value['validatorTimeoutMs'] === undefined ||
      (isNonNegativeNumber(value['validatorTimeoutMs']) && value['validatorTimeoutMs'] > 0)) &&
    isConversationPolicy(value['conversationPolicy'], value['objective'].instructions) &&
    (value['retryPolicy'] === undefined || isRetryPolicy(value['retryPolicy'])) &&
    isBounds(value['bounds']) &&
    isOptionalString(value['principal']) &&
    isGoalRunStatus(value['status']) &&
    (value['terminalReason'] === undefined || isGoalRunTerminalReason(value['terminalReason'])) &&
    isOptionalString(value['failureDetail']) &&
    isTransitionRecord(value['currentTransition']) &&
    Array.isArray(value['attempts']) &&
    value['attempts'].every(isDurableGoalAttempt) &&
    isUsage(value['usage']) &&
    (value['active'] === undefined || isActiveWork(value['active'])) &&
    (value['cancellation'] === undefined || isCancellationMarker(value['cancellation'])) &&
    isNonNegativeInteger(value['controllerRestarts']) &&
    isOptionalString(value['closedAt']) &&
    isNonEmptyString(value['createdAt']) &&
    isNonEmptyString(value['updatedAt'])
  );
}

/** The fail-closed decoder: `true` only for a record of exactly this shape and internal consistency. */
export function isGoalState(value: unknown): value is GoalState {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, TOP_LEVEL_KEYS) &&
    isShape(value) &&
    isConsistent(value)
  );
}

/** Parses stored text; `undefined` for anything that is not a well-formed `GoalState`. */
export function decodeGoalState(text: string): GoalState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  return isGoalState(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface CreateGoalStateInput {
  readonly goalRunId: string;
  readonly identity: GoalIdentity;
  readonly objective: GoalObjective;
  readonly validator: ValidatorIdentity;
  readonly requireDeterministicValidation?: boolean | undefined;
  readonly validatorTimeoutMs?: number | undefined;
  readonly conversationPolicy: GoalConversationPolicy;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  readonly bounds: GoalBudget;
  readonly principal?: string | undefined;
  /** ISO-8601, from Bureau's runtime clock. */
  readonly now: string;
}

const zeroUsage: DurableGoalUsage = { attempts: 0, steps: 0, tokens: 0, durationMs: 0 };

/**
 * Builds the initial `pending` record: revision 1, transition 0. Validates
 * with COR-638's own rules and the objective cap, so an unusable goal is
 * refused before any record is written. Throws `GoalConfigurationError` for a
 * rejected budget, retry policy, or conversation policy,
 * `GoalObjectiveTooLargeError` for an oversized objective, and
 * `InvalidGoalStateError` for any other shape defect.
 */
export function createGoalState(input: CreateGoalStateInput): GoalState {
  validateBudget(input.bounds);
  validateRetryPolicy(input.retryPolicy);
  validateConversationPolicy(input.conversationPolicy, input.objective.instructions);
  const objectiveBytes = objectiveByteLength(input.objective);
  if (objectiveBytes > GOAL_OBJECTIVE_MAXIMUM_BYTES) {
    throw new GoalObjectiveTooLargeError(objectiveBytes);
  }
  const state = JSON.parse(
    JSON.stringify({
      schemaVersion: GOAL_STATE_SCHEMA_VERSION,
      goalRunId: input.goalRunId,
      workflowId: goalWorkflowId(input.goalRunId),
      revision: 1,
      transitionSeq: 0,
      identity: input.identity,
      objective: input.objective,
      validator: input.validator,
      requireDeterministicValidation: input.requireDeterministicValidation ?? false,
      validatorTimeoutMs: input.validatorTimeoutMs,
      conversationPolicy: input.conversationPolicy,
      retryPolicy: input.retryPolicy,
      bounds: input.bounds,
      principal: input.principal,
      status: 'pending',
      currentTransition: {
        seq: 0,
        transitionId: goalTransitionId(input.goalRunId, 0),
        from: 'pending',
        to: 'pending',
        at: input.now,
        cause: 'created',
      },
      attempts: [],
      usage: zeroUsage,
      controllerRestarts: 0,
      createdAt: input.now,
      updatedAt: input.now,
    }),
  ) as unknown;
  if (!isGoalState(state)) {
    throw new InvalidGoalStateError(
      `Bureau goal "${input.goalRunId}" does not describe a valid goal record.`,
    );
  }
  return state;
}
