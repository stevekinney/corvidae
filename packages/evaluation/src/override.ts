/**
 * Release-gate overrides (COR-896, "override authority"). An override is a
 * `gate-override` record `{ gateDecisionId, actor, reason, expiresAt,
 * evidence }` appended to the history. It never mutates the decision it
 * answers; a later run of the same gate reads it.
 *
 * - An override counts only when its `actor` is the gate's
 *   `overrideAuthority` and is not the principal who ran the overridden
 *   decision.
 * - An expiring override clears, until `expiresAt`, a later regression of the
 *   same criterion and metric that is no worse than an `overridable`
 *   regression it answered, when the evaluator is unchanged. It can never
 *   clear a `hard` regression, nor one that was `hard` when it answered.
 *   A decision that passes only because an expiring override cleared a
 *   regression never becomes the gate's baseline, so the regression returns
 *   once the override expires.
 * - A permanent baseline change (`permanentBaselineChange`, no `expiresAt`)
 *   instead accepts the decision's evidence as the gate's baseline from then
 *   on. It can never accept evidence with a hard regression, or evidence an
 *   infrastructure failure left incomplete, and a decision that passed
 *   without any override is already a baseline.
 *
 * {@link recordOverride} refuses an override that could never count before
 * it reaches the history. The gate still re-checks every override it reads,
 * because an override's validity also depends on the gate definition and
 * the time at which a later run reads it.
 */
import {
  GATE_RECORD_SCHEMA_VERSION,
  type GateDecisionRecord,
  type GateDefinition,
  type GateOverrideRecord,
  type OverrideInvalidityReason,
} from './gate';
import type { EvaluationHistory, HistoricalRecord } from './history';

export type OverrideRejection =
  OverrideInvalidityReason | 'hard-regression' | 'nothing-to-override';

/** An override that can never count. It is not appended. */
export class OverrideRejectedError extends Error {
  override readonly name = 'OverrideRejectedError';
  readonly id: string;
  readonly reason: OverrideRejection;

  constructor(id: string, reason: OverrideRejection) {
    super(`Override "${id}" is rejected: ${reason}`);
    this.id = id;
    this.reason = reason;
  }
}

export interface AssessOverrideOptions {
  readonly override: GateOverrideRecord;
  /** The decision the override answers, when the history has it. */
  readonly decision: GateDecisionRecord | undefined;
  /** The gate's current definition. */
  readonly gate: GateDefinition;
  /** When the override would take effect, as an ISO-8601 timestamp. */
  readonly at: string;
  /**
   * The evaluator digest of the run an expiring override would clear. An
   * override answers one evaluator revision; a new revision needs its own.
   * Omitted when a permanent baseline change is assessed, since a baseline
   * may come from any evaluator revision.
   */
  readonly evaluatorDigest?: string | undefined;
}

/** `valid`, or the first reason `override` cannot count at `at`. */
export function assessOverride(options: AssessOverrideOptions): 'valid' | OverrideInvalidityReason {
  const { override, decision, gate, at, evaluatorDigest } = options;
  if (decision === undefined || decision.gateId !== override.gateId) return 'unknown-decision';
  if (override.actor !== gate.overrideAuthority) return 'not-override-authority';
  if (override.actor === decision.actor) return 'decision-actor';
  if (override.expiresAt !== undefined && Date.parse(override.expiresAt) <= Date.parse(at)) {
    return 'expired';
  }
  if (evaluatorDigest !== undefined && decision.candidate.evaluator.digest !== evaluatorDigest) {
    return 'different-evaluator';
  }
  return 'valid';
}

/**
 * Whether `decision` passed with no regression at all. Only such a decision
 * is a `latest-passing-decision` baseline by itself; one that passed because
 * an expiring override cleared a regression needs a permanent baseline change.
 */
export function passedWithoutOverride(decision: GateDecisionRecord): boolean {
  return decision.decision === 'pass' && decision.findings.regressions.length === 0;
}

/**
 * Why `decision` cannot be answered by an override of this kind, or
 * `undefined` when it can. An expiring override needs an overridable
 * regression to answer; a permanent baseline change needs complete evidence
 * without a hard regression that is not already a baseline.
 */
export function decisionRejection(
  decision: GateDecisionRecord,
  permanentBaselineChange: boolean,
): 'hard-regression' | 'nothing-to-override' | undefined {
  const { regressions } = decision.findings;
  if (permanentBaselineChange) {
    if (passedWithoutOverride(decision) || decision.decision === 'infrastructure-failure') {
      return 'nothing-to-override';
    }
    return regressions.some((regression) => regression.severity === 'hard')
      ? 'hard-regression'
      : undefined;
  }
  if (regressions.length === 0) return 'nothing-to-override';
  return regressions.every((regression) => regression.severity === 'hard')
    ? 'hard-regression'
    : undefined;
}

export interface RecordOverrideOptions {
  readonly history: EvaluationHistory;
  /** The overridden gate's current definition. */
  readonly gate: GateDefinition;
  readonly override: Omit<GateOverrideRecord, 'kind' | 'schemaVersion'>;
}

/**
 * Appends an override after checking it could count: the decision exists
 * and belongs to the gate, the actor is the gate's override authority and
 * did not run the decision, it has not already expired, and the decision
 * has something this kind of override may answer. Rejects with
 * {@link OverrideRejectedError} otherwise.
 */
export async function recordOverride(
  options: RecordOverrideOptions,
): Promise<HistoricalRecord<GateOverrideRecord>> {
  const record: GateOverrideRecord = {
    kind: 'gate-override',
    schemaVersion: GATE_RECORD_SCHEMA_VERSION,
    ...options.override,
  };
  const stored = await options.history.read(record.gateDecisionId);
  const decision = stored?.record.kind === 'gate-decision' ? stored.record : undefined;
  const validity = assessOverride({
    override: record,
    decision,
    gate: options.gate,
    at: record.recordedAt,
  });
  if (validity !== 'valid') throw new OverrideRejectedError(record.id, validity);
  const rejection = decisionRejection(decision!, record.permanentBaselineChange);
  if (rejection !== undefined) throw new OverrideRejectedError(record.id, rejection);
  return options.history.append(record);
}
