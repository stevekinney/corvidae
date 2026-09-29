/**
 * Release-promotion signals (COR-1352). A signal turns one passing, unexpired
 * gate decision into attributed evidence that exactly one package, model,
 * prompt version, dataset version, evaluator, and source revision cleared the
 * gate. It is evidence only: issuing one publishes, tags, syncs, and deploys
 * nothing, and nothing in the repository consumes it. A release owner reads
 * it; any future consumer needs its own decision.
 *
 * What a signal binds, and where each value comes from:
 *
 * - `package`: the workspace the gate names in its `package` field, and its
 *   source revision, the git tree of that workspace's directory at the
 *   signal's source revision. It moves only when the package's own files do.
 * - `model`: the model judge's provider, provider-native model id, and
 *   effort. The provider comes from operative's model catalog, which also
 *   resolves an alias to the model it names. `null` for a judge that is not a
 *   model: there is no model to bind, and that fact is bound instead.
 * - `promptVersion` and `dataset`: the evaluator configuration's judge prompt
 *   version and the evaluated dataset's id and version.
 * - `evaluator`: the evaluator identity, whose digest covers the whole
 *   configuration (its declared `codeRevision` included).
 * - `sourceRevision`: the repository revision the gate ran at, which the
 *   decision records. A signal is issued only when it is the revision checked
 *   out now, so evidence about one commit never promotes another.
 *
 * {@link issuePromotionSignal} issues a signal only from a decision that
 * passed, whose every override it relied on is still valid, that has not
 * expired, and whose bound values all still hold. It appends one
 * `promotion-signal` record to the append-only history and never touches the
 * decision. {@link verifyPromotionSignal} later reports the signal `valid`,
 * `expired`, or `stale`, listing every bound field whose current value
 * differs. A signal is never evergreen: it expires at the earliest of
 * {@link PROMOTION_SIGNAL_MAXIMUM_LIFETIME_MS} after its decision, the gate's
 * `maximumAgeMs` after its decision, and the expiry of any override it relied
 * on. To withdraw one, issue nothing further; it expires or goes stale.
 *
 * This module imports the history and the release gate for types only, so
 * the history can keep `promotion-signal` records without an import cycle.
 * A corrupt stored record therefore rejects with the history's
 * `CorruptHistoricalRecordError`, which the command reports as exit 65.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import { createModelCatalog } from '@lostgradient/operative';
import { z } from 'zod';

import {
  codeRevisionSchema,
  EFFORTS,
  identifier,
  type JudgeConfiguration,
  parseEvaluatorConfiguration,
} from './configuration';
import { parseEvaluationDataset } from './datasets';
import { digestSchema, historicalRecordIdSchema } from './evaluation-run';
import type { GateDecisionRecord, GateOverrideRecord } from './gate';
import type { EvaluationHistory, HistoricalRecord } from './history';
import { canonicalJson, evaluatorIdentity } from './identity';
import { assessOverride } from './override';
import type { GateEvaluatorDefinition } from './release-gate';

/** The version of the `promotion-signal` record shape this package writes. */
export const PROMOTION_SIGNAL_SCHEMA_VERSION = 1;

/** The longest a signal outlives its decision, whatever the gate allows: one day. */
export const PROMOTION_SIGNAL_MAXIMUM_LIFETIME_MS = 86_400_000;

const timestamp = z.iso.datetime({ offset: true });

const modelBindingSchema = z.strictObject({
  provider: identifier,
  /** The provider-native model id, after any alias. */
  model: identifier,
  effort: z.enum(EFFORTS),
});

export const promotionSignalSchema = z
  .strictObject({
    signalId: historicalRecordIdSchema,
    package: z.strictObject({ name: identifier, sourceRevision: codeRevisionSchema }),
    /** `null` exactly when the evaluator's judge is not a model. */
    model: modelBindingSchema.nullable(),
    promptVersion: identifier,
    dataset: z.strictObject({ id: identifier, version: identifier }),
    evaluator: z.strictObject({
      name: identifier,
      revision: z.number().int().positive(),
      digest: digestSchema,
    }),
    sourceRevision: codeRevisionSchema,
    gateDecisionRecordId: historicalRecordIdSchema,
    /** The overrides that cleared a regression in the decision, which the signal relies on. */
    overrideRecordIds: z.array(historicalRecordIdSchema),
    /** When the gate decided. */
    decidedAt: timestamp,
    issuedAt: timestamp,
    /** The principal who issued the signal. */
    actor: identifier,
    expiresAt: timestamp,
    /** The SHA-256 of the signal's canonical JSON without this field. */
    digest: digestSchema,
  })
  .superRefine((signal, context) => {
    // A missing timestamp is already reported; `Date.parse` of it is NaN, which never compares.
    const decidedAt = Date.parse(signal.decidedAt);
    const issuedAt = Date.parse(signal.issuedAt);
    if (issuedAt < decidedAt) {
      context.addIssue({
        code: 'custom',
        path: ['issuedAt'],
        message: 'A signal cannot be issued before its gate decided',
      });
    }
    if (Date.parse(signal.expiresAt) <= issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'A signal must expire after it is issued',
      });
    }
  });

export type PromotionSignal = z.output<typeof promotionSignalSchema>;

/** Everything a signal binds; a later change to any of it makes the signal stale. */
export type PromotionBindings = Pick<
  PromotionSignal,
  'package' | 'model' | 'promptVersion' | 'dataset' | 'evaluator' | 'sourceRevision'
>;

/** How the history keeps a signal: under its own id, at the time it was issued. */
export const promotionSignalRecordSchema = z
  .strictObject({
    kind: z.literal('promotion-signal'),
    schemaVersion: z.literal(PROMOTION_SIGNAL_SCHEMA_VERSION),
    id: historicalRecordIdSchema,
    recordedAt: timestamp,
    signal: promotionSignalSchema,
  })
  .superRefine((record, context) => {
    if (record.id !== record.signal.signalId) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'A promotion signal is kept under its own signal id',
      });
    }
    if (record.recordedAt !== record.signal.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['recordedAt'],
        message: 'A promotion signal is recorded when it is issued',
      });
    }
  });

export type PromotionSignalRecord = z.output<typeof promotionSignalRecordSchema>;

/** The SHA-256 of `signal`'s canonical JSON without its `digest` field. */
export function promotionSignalDigest(
  signal: Omit<PromotionSignal, 'digest'> & { readonly digest?: string },
): Promise<string> {
  const { digest: _digest, ...fields } = signal;
  return sha256Hex(canonicalJson(fields));
}

export const PROMOTION_SIGNAL_EXIT_CODES = {
  issued: 0,
  valid: 0,
  'insufficient-evidence': 3,
  expired: 3,
  unresolvable: 3,
  stale: 5,
  'usage-error': 64,
  'corrupt-record': 65,
} as const;

export type PromotionResult = keyof typeof PROMOTION_SIGNAL_EXIT_CODES;

/** One bound field whose value differs: what the decision or signal binds, and what it is now. */
export interface StaleBinding {
  /** The field's path, such as `model.effort` or `sourceRevision`. */
  readonly field: string;
  readonly bound: unknown;
  readonly current: unknown;
}

export type PromotionEvidenceReason =
  | 'decision-missing'
  | 'decision-not-passing'
  | 'decision-expired'
  | 'override-invalid'
  | 'package-undeclared'
  | 'source-revision-unrecorded';

export type PromotionIssueOutcome =
  | {
      readonly result: 'issued';
      readonly signal: PromotionSignal;
      /** The history's digest of the appended `promotion-signal` record. */
      readonly recordDigest: string;
    }
  | {
      readonly result: 'insufficient-evidence';
      readonly gateDecisionRecordId: string;
      readonly reason: PromotionEvidenceReason;
      readonly problem: string;
    }
  | {
      readonly result: 'unresolvable';
      readonly gateDecisionRecordId: string;
      readonly problem: string;
    }
  | {
      readonly result: 'stale';
      readonly gateDecisionRecordId: string;
      readonly stale: readonly StaleBinding[];
    };

export type PromotionVerification =
  | { readonly result: 'valid'; readonly signal: PromotionSignal }
  | { readonly result: 'expired'; readonly signal: PromotionSignal; readonly checkedAt: string }
  | {
      readonly result: 'stale';
      readonly signal: PromotionSignal;
      readonly stale: readonly StaleBinding[];
    }
  | {
      readonly result: 'insufficient-evidence';
      readonly signalId: string;
      readonly reason: 'signal-missing';
      readonly problem: string;
    }
  | { readonly result: 'unresolvable'; readonly signalId: string; readonly problem: string }
  | { readonly result: 'corrupt-record'; readonly recordId: string; readonly problem: string };

/** The repository as it stands when a signal is issued or verified. */
export interface PromotionContext {
  readonly history: EvaluationHistory;
  /**
   * The revision checked out now (`git rev-parse HEAD` in the command), or
   * `undefined` when it cannot be determined.
   */
  readonly currentRevision: string | undefined;
  /** Builds the evaluator module a decision names, given its path as the decision records it. */
  readonly loadEvaluator: (module: string) => Promise<GateEvaluatorDefinition>;
  /**
   * The source revision of the named workspace at `revision` (the git tree
   * of its directory), or `undefined` when it cannot be found.
   */
  readonly packageSourceRevision: (
    name: string,
    revision: string,
  ) => string | undefined | Promise<string | undefined>;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

export interface IssuePromotionSignalOptions extends PromotionContext {
  /** The principal issuing the signal. */
  readonly actor: string;
  /** The signal's id. Defaults to the gate id, the issue time, and a random suffix. */
  readonly createId?: ((decision: GateDecisionRecord, issuedAt: string) => string) | undefined;
}

/** Why the current value of a bound field cannot be determined. */
class UnresolvableBinding extends Error {
  override readonly name = 'UnresolvableBinding';

  /** `cause` is the failure behind the problem, when there is one. */
  constructor(problem: string, cause?: unknown) {
    super(problem, cause === undefined ? undefined : { cause });
  }
}

function isGateDecision(
  stored: HistoricalRecord | undefined,
): stored is HistoricalRecord<GateDecisionRecord> {
  return stored?.record.kind === 'gate-decision';
}

/** The newest decision of `gateId`, whatever its outcome, or `undefined` when the gate never ran. */
export async function latestGateDecision(
  history: EvaluationHistory,
  gateId: string,
): Promise<HistoricalRecord<GateDecisionRecord> | undefined> {
  const records = await history.list();
  return records.filter(isGateDecision).findLast(({ record }) => record.gateId === gateId);
}

/** The catalog backend `model` names, by its provider-native id or an alias. */
function modelBinding(judge: JudgeConfiguration): PromotionBindings['model'] {
  if (judge.kind !== 'model') return null;
  const backend = createModelCatalog().descriptors.find(
    (descriptor) =>
      descriptor.model === judge.model ||
      descriptor.aliases.some((alias) => alias.alias === judge.model),
  );
  if (backend === undefined) {
    throw new UnresolvableBinding(
      `Judge model "${judge.model}" is not in operative’s model catalog, so its provider cannot be bound`,
    );
  }
  return { provider: backend.provider, model: backend.model, effort: judge.effort };
}

async function loadConfiguration(module: string, context: PromotionContext) {
  try {
    const definition = await context.loadEvaluator(module);
    return {
      configuration: parseEvaluatorConfiguration(definition.configuration),
      dataset: parseEvaluationDataset(definition.dataset),
    };
  } catch (error) {
    throw new UnresolvableBinding(
      `The evaluator module ${module} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Every bound value as the repository has it now: the named package at the
 * current revision, and the evaluator module the decision names. Throws
 * {@link UnresolvableBinding} when any of them cannot be determined.
 */
async function currentBindings(
  module: string,
  packageName: string,
  context: PromotionContext,
): Promise<PromotionBindings> {
  const revision = context.currentRevision;
  if (revision === undefined) {
    throw new UnresolvableBinding('The current source revision cannot be determined');
  }
  const packageRevision = await context.packageSourceRevision(packageName, revision);
  if (packageRevision === undefined) {
    throw new UnresolvableBinding(
      `The source revision of workspace "${packageName}" at ${revision} cannot be resolved`,
    );
  }
  const { configuration, dataset } = await loadConfiguration(module, context);
  return {
    package: { name: packageName, sourceRevision: packageRevision },
    model: modelBinding(configuration.judge),
    promptVersion: configuration.promptVersion,
    dataset: { id: dataset.id, version: dataset.version },
    evaluator: await evaluatorIdentity(configuration),
    sourceRevision: revision,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Every leaf where `bound` and `current` differ, in canonical key order. */
function staleBindings(
  bound: unknown,
  current: unknown,
  path: readonly string[] = [],
): StaleBinding[] {
  if (isObject(bound) && isObject(current)) {
    const keys = [...new Set([...Object.keys(bound), ...Object.keys(current)])].toSorted();
    return keys.flatMap((key) => staleBindings(bound[key], current[key], [...path, key]));
  }
  return canonicalJson(bound) === canonicalJson(current)
    ? []
    : [{ field: path.join('.'), bound, current }];
}

/**
 * The overrides a passing decision relied on, each still valid at `at`, or
 * why one no longer is. A decision passes over an overridable regression
 * only while the override that cleared it stands.
 */
async function reliedOnOverrides(
  decision: GateDecisionRecord,
  history: EvaluationHistory,
  at: string,
): Promise<GateOverrideRecord[] | string> {
  const overrides: GateOverrideRecord[] = [];
  for (const id of decision.overrides.applied) {
    const stored = await history.read(id);
    if (stored?.record.kind !== 'gate-override') {
      return `Override "${id}" that cleared the decision’s regression is not in the history`;
    }
    const override = stored.record;
    const answered = await history.read(override.gateDecisionId);
    const validity = assessOverride({
      override,
      decision: isGateDecision(answered) ? answered.record : undefined,
      gate: decision.gate,
      at,
      evaluatorDigest: decision.candidate.evaluator.digest,
    });
    if (validity !== 'valid') {
      return `Override "${id}" no longer clears the decision’s regression: ${validity}`;
    }
    overrides.push(override);
  }
  return overrides;
}

/** The earliest of the signal lifetime, the gate's maximum age, and every relied-on override's expiry. */
function expiryOf(decision: GateDecisionRecord, overrides: readonly GateOverrideRecord[]): string {
  const decidedAt = Date.parse(decision.recordedAt);
  const bounds = [decidedAt + PROMOTION_SIGNAL_MAXIMUM_LIFETIME_MS];
  const { maximumAgeMs } = decision.gate.expiry;
  if (maximumAgeMs !== undefined) bounds.push(decidedAt + maximumAgeMs);
  for (const { expiresAt } of overrides) {
    if (expiresAt !== undefined) bounds.push(Date.parse(expiresAt));
  }
  return new Date(Math.min(...bounds)).toISOString();
}

function defaultSignalId(decision: GateDecisionRecord, issuedAt: string): string {
  return `${decision.gateId}.signal.${issuedAt.replaceAll(/[-:.]/g, '')}.${crypto.randomUUID().slice(0, 8)}`;
}

/** What a promotable decision provides a signal, or why the decision cannot be promoted. */
type EvidenceCheck =
  | {
      readonly packageName: string;
      readonly sourceRevision: string;
      readonly expiresAt: string;
    }
  | { readonly reason: PromotionEvidenceReason; readonly problem: string };

/**
 * Checks everything about `decision` that needs no current value: it passed,
 * every override it relied on still stands at `issuedAt`, it has not
 * expired, and it names a package and records its source revision.
 */
async function checkEvidence(
  decision: GateDecisionRecord,
  history: EvaluationHistory,
  issuedAt: string,
): Promise<EvidenceCheck> {
  if (decision.decision !== 'pass') {
    return {
      reason: 'decision-not-passing',
      problem: `Gate decision "${decision.id}" is ${decision.decision}, not pass`,
    };
  }
  const overrides = await reliedOnOverrides(decision, history, issuedAt);
  if (typeof overrides === 'string') return { reason: 'override-invalid', problem: overrides };
  const expiresAt = expiryOf(decision, overrides);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    return {
      reason: 'decision-expired',
      problem: `Gate decision "${decision.id}" expired at ${expiresAt}`,
    };
  }
  if (decision.gate.package === undefined) {
    return {
      reason: 'package-undeclared',
      problem: `Gate "${decision.gateId}" names no package, so a signal cannot bind one`,
    };
  }
  if (decision.sourceRevision === undefined) {
    return {
      reason: 'source-revision-unrecorded',
      problem: `Gate decision "${decision.id}" does not record the source revision it ran at`,
    };
  }
  return { packageName: decision.gate.package, sourceRevision: decision.sourceRevision, expiresAt };
}

/**
 * Issues a promotion signal from one gate decision and appends it to the
 * history. Issues nothing, and appends nothing, unless the decision passed,
 * every override it relied on is still valid, it has not expired, and every
 * bound value still holds: the decision's source revision is the current one,
 * and the evaluator module it names still builds the same evaluator and
 * dataset. Rejects with the history's `CorruptHistoricalRecordError` when a
 * record it reads is corrupt.
 */
export async function issuePromotionSignal(
  gateDecisionRecordId: string,
  options: IssuePromotionSignalOptions,
): Promise<PromotionIssueOutcome> {
  const { history } = options;
  const stored = await history.read(gateDecisionRecordId);
  if (!isGateDecision(stored)) {
    return {
      result: 'insufficient-evidence',
      gateDecisionRecordId,
      reason: 'decision-missing',
      problem: `No gate decision "${gateDecisionRecordId}"`,
    };
  }
  const decision = stored.record;
  const issuedAt = new Date((options.now ?? Date.now)()).toISOString();
  const evidence = await checkEvidence(decision, history, issuedAt);
  if ('problem' in evidence) {
    return { result: 'insufficient-evidence', gateDecisionRecordId, ...evidence };
  }
  let current: PromotionBindings;
  try {
    current = await currentBindings(decision.evaluator.module, evidence.packageName, options);
  } catch (error) {
    if (!(error instanceof UnresolvableBinding)) throw error;
    return { result: 'unresolvable', gateDecisionRecordId, problem: error.message };
  }
  // The decision records these itself; the rest follow from its evaluator digest.
  const { name, revision, digest } = decision.evaluator;
  const stale = staleBindings(
    {
      dataset: { id: decision.dataset.id, version: decision.dataset.version },
      evaluator: { name, revision, digest },
      sourceRevision: evidence.sourceRevision,
    },
    {
      dataset: current.dataset,
      evaluator: current.evaluator,
      sourceRevision: current.sourceRevision,
    },
  );
  if (stale.length > 0) return { result: 'stale', gateDecisionRecordId, stale };
  const fields: Omit<PromotionSignal, 'digest'> = {
    signalId: (options.createId ?? defaultSignalId)(decision, issuedAt),
    ...current,
    gateDecisionRecordId: decision.id,
    overrideRecordIds: [...decision.overrides.applied],
    decidedAt: decision.recordedAt,
    issuedAt,
    actor: options.actor,
    expiresAt: evidence.expiresAt,
  };
  const signal: PromotionSignal = { ...fields, digest: await promotionSignalDigest(fields) };
  const appended = await history.append<PromotionSignalRecord>({
    kind: 'promotion-signal',
    schemaVersion: PROMOTION_SIGNAL_SCHEMA_VERSION,
    id: signal.signalId,
    recordedAt: issuedAt,
    signal,
  });
  return { result: 'issued', signal, recordDigest: appended.digest };
}

/**
 * Checks a stored signal against the repository as it is now: `expired` from
 * its `expiresAt` on, otherwise `stale` with every bound field whose current
 * value differs, otherwise `valid`. Never writes. Rejects with the history's
 * `CorruptHistoricalRecordError` when a record it reads is corrupt.
 */
export async function verifyPromotionSignal(
  signalId: string,
  current: PromotionContext,
): Promise<PromotionVerification> {
  const { history } = current;
  const stored = await history.read(signalId);
  if (stored?.record.kind !== 'promotion-signal') {
    return {
      result: 'insufficient-evidence',
      signalId,
      reason: 'signal-missing',
      problem: `No promotion signal "${signalId}"`,
    };
  }
  const { signal } = stored.record;
  if ((await promotionSignalDigest(signal)) !== signal.digest) {
    return {
      result: 'corrupt-record',
      recordId: signalId,
      problem: `Promotion signal "${signalId}" does not match its own digest`,
    };
  }
  const checkedAt = new Date((current.now ?? Date.now)()).toISOString();
  if (Date.parse(signal.expiresAt) <= Date.parse(checkedAt)) {
    return { result: 'expired', signal, checkedAt };
  }
  const decision = await history.read(signal.gateDecisionRecordId);
  if (!isGateDecision(decision)) {
    return {
      result: 'corrupt-record',
      recordId: signalId,
      problem: `Promotion signal "${signalId}" names gate decision "${signal.gateDecisionRecordId}", which the history does not hold`,
    };
  }
  let now: PromotionBindings;
  try {
    now = await currentBindings(decision.record.evaluator.module, signal.package.name, current);
  } catch (error) {
    if (!(error instanceof UnresolvableBinding)) throw error;
    return { result: 'unresolvable', signalId, problem: error.message };
  }
  const { package: bound, model, promptVersion, dataset, evaluator, sourceRevision } = signal;
  const stale = staleBindings(
    { package: bound, model, promptVersion, dataset, evaluator, sourceRevision },
    now,
  );
  return stale.length === 0 ? { result: 'valid', signal } : { result: 'stale', signal, stale };
}
