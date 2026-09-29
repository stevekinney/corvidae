/**
 * Evaluator disagreement (COR-896, "evaluator disagreement"). When repeated
 * trials, or two judges scoring the same case, diverge past the variance
 * policy, the outcome is `disagreement`: a first-class result carrying the
 * per-trial or per-judge breakdown, never collapsed into a pass or a fail.
 *
 * The trial rule, for trials that all produced a verdict:
 *
 * - Unanimous trials decide on their own: all `pass` is `pass`, and all
 *   `fail` or `agent-failed` is `fail`. The configuration schema guarantees a
 *   unanimous result always meets its policy's interval width.
 * - A split passes only when its pass fraction reaches the policy's
 *   `minimumPassFraction` and its 95 percent Wilson interval is no wider than
 *   `maximumIntervalWidth`. Otherwise it is `disagreement`, naming each
 *   threshold it missed.
 * - Without a policy (only a deterministic judge may omit one), any split is
 *   `disagreement`: a deterministic judge that saw different verdicts has no
 *   rule for choosing between them.
 *
 * Infrastructure failures never reach this rule; `trials.ts` reports them as
 * `indeterminate` first.
 */
import type { EvaluatorIdentity } from './identity';
import { summarizeProportion, type VariancePolicy } from './variance';
import type { CaseVerdict } from './verdict';

/** Every outcome a case can have across repeated trials or across judges. */
export type AggregateOutcome = 'pass' | 'fail' | 'disagreement' | 'indeterminate';

export const DISAGREEMENT_REASONS = [
  'below-minimum-pass-fraction',
  'interval-too-wide',
  'split-without-variance-policy',
] as const;

export type DisagreementReason = (typeof DISAGREEMENT_REASONS)[number];

/** One trial's verdict. Infrastructure failures are handled before any decision. */
export interface TrialVerdict {
  readonly trial: number;
  readonly verdict: Exclude<CaseVerdict, 'infrastructure-failure'>;
}

export interface Disagreement {
  readonly reasons: readonly DisagreementReason[];
  /** Every trial's verdict, in trial order. */
  readonly breakdown: readonly TrialVerdict[];
}

export type TrialDecision =
  | { readonly outcome: 'pass' | 'fail' }
  | { readonly outcome: 'disagreement'; readonly disagreement: Disagreement };

/** Collapses the verdicts of repeated trials into an outcome under `policy`. */
export function decideTrials(
  verdicts: readonly TrialVerdict[],
  policy: VariancePolicy | undefined,
): TrialDecision {
  if (verdicts.length === 0) throw new RangeError('Cannot decide an outcome from zero trials');
  const passes = verdicts.filter((entry) => entry.verdict === 'pass').length;
  if (passes === verdicts.length) return { outcome: 'pass' };
  if (passes === 0) return { outcome: 'fail' };

  const reasons: DisagreementReason[] = [];
  if (policy === undefined) {
    reasons.push('split-without-variance-policy');
  } else {
    // A split has at least one trial, so both statistics are present.
    const { passFraction, wilsonInterval } = summarizeProportion(passes, verdicts.length);
    if (passFraction! < policy.minimumPassFraction) reasons.push('below-minimum-pass-fraction');
    if (wilsonInterval!.width > policy.maximumIntervalWidth) reasons.push('interval-too-wide');
  }
  if (reasons.length === 0) return { outcome: 'pass' };
  return { outcome: 'disagreement', disagreement: { reasons, breakdown: [...verdicts] } };
}

/** What one judge concluded about one case. A `TrialAggregate` satisfies it. */
export interface JudgedCase {
  readonly evaluator: EvaluatorIdentity;
  readonly caseId: string;
  readonly datasetVersion: string;
  readonly codeRevision: string;
  readonly outcome: AggregateOutcome;
}

export interface JudgeReconciliation {
  readonly caseId: string;
  readonly outcome: AggregateOutcome;
  /** Each judge's own outcome, in the order given. */
  readonly judges: readonly {
    readonly evaluator: EvaluatorIdentity;
    readonly outcome: AggregateOutcome;
  }[];
}

function requireSame(
  cases: readonly JudgedCase[],
  key: 'caseId' | 'datasetVersion' | 'codeRevision',
): void {
  const values = new Set(cases.map((entry) => entry[key]));
  if (values.size > 1) {
    throw new RangeError(
      `Judges can only be reconciled on one ${key}, not ${[...values].join(', ')}`,
    );
  }
}

/**
 * Reconciles two or more judges scoring the same case at the same dataset
 * version and code revision. Any `indeterminate` judge makes the result
 * `indeterminate`; judges that reach the same `pass` or `fail` keep it; any
 * other combination is `disagreement`.
 */
export function reconcileJudges(cases: readonly JudgedCase[]): JudgeReconciliation {
  if (cases.length < 2) throw new RangeError('Reconciling judges needs at least two judges');
  if (new Set(cases.map((entry) => entry.evaluator.digest)).size !== cases.length) {
    throw new RangeError('Reconciling judges needs distinct evaluators');
  }
  requireSame(cases, 'caseId');
  requireSame(cases, 'datasetVersion');
  requireSame(cases, 'codeRevision');
  const outcomes = new Set(cases.map((entry) => entry.outcome));
  const [first] = outcomes;
  let outcome: AggregateOutcome;
  if (outcomes.has('indeterminate')) outcome = 'indeterminate';
  else if (outcomes.size === 1 && (first === 'pass' || first === 'fail')) outcome = first;
  else outcome = 'disagreement';
  return {
    caseId: cases[0]!.caseId,
    outcome,
    judges: cases.map((entry) => ({ evaluator: entry.evaluator, outcome: entry.outcome })),
  };
}
