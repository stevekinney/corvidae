/**
 * Why a generation was planned onto the model it ran on (COR-1810).
 *
 * A {@link PlanReason} is a short, closed answer to "why this model": one of six codes, a line of
 * detail, and the models the plan passed over, each with the code that passed it over. It is derived
 * from what the selector already knew, never from the content of a request, so it is safe to record
 * on a step and to show next to a reply.
 *
 * The codes read as follows:
 *
 * - `pinned`: the agent, the user, or a steering command named this model, so nothing was ranked.
 * - `fallback`: the plan's model is what remained after the better-ranked ones were unavailable
 *   (`unavailable`, `unhealthy`, or a stale catalog), or the provider answered with a model other
 *   than the planned one.
 * - `capability`: it is the only model left once the others lacked a capability the request needs
 *   (a required capability, an input modality, or an effort tier).
 * - `policy`: it is the only model the layered model policy leaves, or the policy and the agent's
 *   own preferences ranked it first without a cost or latency preference deciding.
 * - `cost`, `latency`: two or more models were eligible and the matching preference put this one
 *   ahead.
 *
 * @module plan-reason
 */

import type { SteeringDesiredState } from '../durable/types.ts';
import type { SelectionExclusionCode, UserModelConfiguration } from './policy.ts';
import type { SelectionCandidate, SelectionPlan } from './selection.ts';

/** The six reasons a plan can give for the model it chose. */
export type PlanReasonCode = 'cost' | 'latency' | 'capability' | 'policy' | 'pinned' | 'fallback';

/** The reasons a model can be passed over: a subset of {@link PlanReasonCode}. */
export type PlanRejectionCode = 'capability' | 'policy' | 'fallback';

/** One model the plan passed over, and why. */
export interface PlanRejection {
  /** The provider that serves the model. */
  readonly provider: string;
  /** The model that was passed over. */
  readonly model: string;
  /** Why it was passed over. */
  readonly code: PlanRejectionCode;
}

/** Why a generation ran on the model it did. */
export interface PlanReason {
  /** The deciding reason. */
  readonly code: PlanReasonCode;
  /** One line that says it in words; never request content. */
  readonly detail: string;
  /** The models the plan passed over, at most {@link MAXIMUM_PLAN_REJECTIONS}, in catalog order. */
  readonly rejected: readonly PlanRejection[];
}

/** The most rejected models a {@link PlanReason} lists; a plan that passed over more says how many in `detail`. */
export const MAXIMUM_PLAN_REJECTIONS = 50;

/** The longest `detail` a {@link PlanReason} carries. */
const DETAIL_LIMIT = 300;

/** Map a selector exclusion to the code a reply's details show. */
export function rejectionCodeOf(code: SelectionExclusionCode | undefined): PlanRejectionCode {
  switch (code) {
    case 'missing-required-capability':
    case 'incompatible-modality':
    case 'incompatible-effort':
      return 'capability';
    case 'unavailable':
    case 'unhealthy':
    case 'stale-catalog':
      return 'fallback';
    case 'denied-by-deployment':
    case 'denied-by-bureau':
    case 'exceeds-delegated-authority':
    case 'denied-by-user':
    case undefined:
      return 'policy';
  }
}

function bounded(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT - 1)}…`;
}

function weightOf(preference: string | undefined): number {
  if (preference === 'lowest-cost' || preference === 'lowest-latency') return 1;
  if (preference === 'balanced') return 0.5;
  return 0;
}

/** What {@link derivePlanReason} reads from a finished selection. */
export interface DerivePlanReasonInput {
  /** The eligible candidates, best ranked first, each with its ranking inputs. */
  readonly ranked: readonly SelectionCandidate[];
  /** The candidates the policy, the request, or availability passed over. */
  readonly rejected: readonly SelectionCandidate[];
  /** Whether an exact override (a pin) chose the model. */
  readonly pinned: boolean;
  /** The user's cost preference, when one is set. */
  readonly costPreference?: UserModelConfiguration['costPreference'] | undefined;
  /** The user's latency preference, when one is set. */
  readonly latencyPreference?: UserModelConfiguration['latencyPreference'] | undefined;
}

/**
 * The reason for a selection, by this order: pinned; the only eligible model left (named for what
 * rejected the rest); the preference whose weighted advantage over the runner-up is largest
 * (`cost` or `latency`); else `policy`.
 */
export function derivePlanReason(input: DerivePlanReasonInput): PlanReason {
  const { ranked, rejected } = input;
  const winner = ranked[0]!;
  const winnerName = `${winner.provider}/${winner.model}`;
  const rejections: PlanRejection[] = rejected
    .slice(0, MAXIMUM_PLAN_REJECTIONS)
    .map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      code: rejectionCodeOf(candidate.exclusionCode),
    }));
  const omitted = rejected.length - rejections.length;
  const suffix =
    omitted > 0
      ? ` (${rejected.length} models were passed over; the first ${MAXIMUM_PLAN_REJECTIONS} are listed)`
      : '';

  if (input.pinned) {
    return { code: 'pinned', detail: bounded(`Pinned to ${winnerName}`), rejected: rejections };
  }
  if (ranked.length === 1) {
    if (rejected.length === 0) {
      return {
        code: 'policy',
        detail: bounded(`${winnerName} is the only model the policy offers`),
        rejected: rejections,
      };
    }
    const counts = new Map<PlanRejectionCode, number>();
    for (const rejection of rejected) {
      const code = rejectionCodeOf(rejection.exclusionCode);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    // The most common reason decides; a tie goes to the policy, then the capability, then the fallback.
    let code: PlanRejectionCode = 'policy';
    for (const candidate of ['policy', 'capability', 'fallback'] as const) {
      if ((counts.get(candidate) ?? 0) > (counts.get(code) ?? 0)) code = candidate;
    }
    const reasons = [...new Set(rejected.map((candidate) => candidate.exclusionCode ?? 'policy'))];
    return {
      code,
      detail: bounded(
        `${winnerName} is the only eligible model; the others were excluded (${reasons.join(', ')})${suffix}`,
      ),
      rejected: rejections,
    };
  }
  const runnerUp = ranked[1]!;
  const costAdvantage =
    weightOf(input.costPreference) *
    ((winner.rankingInputs?.['cost'] ?? 0) - (runnerUp.rankingInputs?.['cost'] ?? 0));
  const latencyAdvantage =
    weightOf(input.latencyPreference) *
    ((winner.rankingInputs?.['latency'] ?? 0) - (runnerUp.rankingInputs?.['latency'] ?? 0));
  if (latencyAdvantage > 0 && latencyAdvantage > costAdvantage) {
    return {
      code: 'latency',
      detail: bounded(
        `${winnerName} ranked ahead of ${runnerUp.provider}/${runnerUp.model} on latency`,
      ),
      rejected: rejections,
    };
  }
  if (costAdvantage > 0) {
    return {
      code: 'cost',
      detail: bounded(
        `${winnerName} ranked ahead of ${runnerUp.provider}/${runnerUp.model} on cost`,
      ),
      rejected: rejections,
    };
  }
  return {
    code: 'policy',
    detail: bounded(
      `${winnerName} ranked first among ${ranked.length} eligible models on the agent's preferences, then by name`,
    ),
    rejected: rejections,
  };
}

/**
 * The reason one step's generation ran on the model it did: the plan's own reason, replaced by
 * `pinned` when a steering command named the provider, model, or route the plan did not choose, and
 * by `fallback` when the plan records that the provider answered with another model. A run with no
 * plan and no steering override ran the model its agent names, which is `pinned`. `undefined` only
 * when a plan carries no reason.
 */
export function planReasonForStep(
  plan: SelectionPlan | undefined,
  steering: SteeringDesiredState | undefined,
): PlanReason | undefined {
  const base = plan?.reason;
  const selected = plan?.outcome === 'selected' ? plan.selected : undefined;
  const steeredModel = steering?.model;
  const steeredProvider = steering?.provider ?? steering?.modelProvider;
  const steeredRoute = steering?.route;
  const steered =
    (steeredModel !== undefined && steeredModel !== selected?.model) ||
    (steeredProvider !== undefined && steeredProvider !== selected?.provider) ||
    (steeredRoute !== undefined && steeredRoute !== selected?.route);
  if (steered) {
    const named = [steeredProvider, steeredModel, steeredRoute].filter(
      (part): part is string => part !== undefined,
    );
    return {
      code: 'pinned',
      detail: bounded(`Steered to ${named.join('/')}`),
      rejected: base?.rejected ?? [],
    };
  }
  if (plan?.outcome === 'provider-effective-divergence' && base !== undefined) {
    return {
      code: 'fallback',
      detail: bounded(plan.failure.reason),
      rejected: base.rejected,
    };
  }
  // COR-1810: an agent that names its model runs with no selection plan; say so rather than nothing.
  if (plan === undefined) {
    return {
      code: 'pinned',
      detail: 'The agent names its model; no selection plan ran',
      rejected: [],
    };
  }
  return base;
}
