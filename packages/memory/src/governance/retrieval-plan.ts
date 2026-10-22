import { sha256HexSync } from '@lostgradient/cryptography';

import type { MemorySourceKind } from './policy';

/**
 * The stages a retrieval plan can select, in the order `recallForModel` runs
 * them. Constraint stages (`temporal-filter`, `entity-filter`,
 * `source-session-constraint`) narrow the authorized candidates before any of
 * them is scored; the scoring stages (`exact-lexical`, `semantic`) feed
 * `rank-fusion`; the expansion stages (`provenance-expansion`,
 * `context-expansion`, `reformulation`, `counterevidence`) run around
 * admission. A stage left out of a plan does not run, and the bundle records
 * what every selected stage did.
 */
export const MEMORY_RETRIEVAL_STAGES = [
  'temporal-filter',
  'entity-filter',
  'source-session-constraint',
  'exact-lexical',
  'semantic',
  'rank-fusion',
  'reformulation',
  'provenance-expansion',
  'context-expansion',
  'counterevidence',
] as const;

/** One stage of a {@link MemoryRetrievalPlan}. */
export type MemoryRetrievalStage = (typeof MEMORY_RETRIEVAL_STAGES)[number];

/**
 * The policy filters every recall runs, in order, before any candidate is
 * scored. `principal`, `tenant`, and `resource` are enforced by the caller's
 * scopes and the shared resource predicate; the rest read each record's
 * persisted governance. `deletion` never excludes a stored record: a removed
 * record is no longer listed at all, and a record a deletion has only claimed
 * stays recallable until its synchronous lane removes it.
 */
export const MEMORY_POLICY_FILTERS = [
  'principal',
  'tenant',
  'resource',
  'purpose',
  'classification',
  'trust',
  'retention',
  'eviction',
  'quarantine',
  'index',
  'supersession',
  'deletion',
] as const;

/** One pre-scoring policy filter. */
export type MemoryPolicyFilter = (typeof MEMORY_POLICY_FILTERS)[number];

/**
 * Why a recall stopped. Exactly one is recorded on every bundle:
 * `sufficient` when the limit or token budget was filled, `exhausted` when
 * candidates or a candidate, iteration, cost, or latency budget ran out first,
 * `unavailable` when the caller may not recall or names nothing to recall
 * from, `canceled` when the caller's signal aborted, and `failed` when a
 * scoring dependency threw.
 */
export const MEMORY_RECALL_STOP_REASONS = [
  'sufficient',
  'exhausted',
  'unavailable',
  'canceled',
  'failed',
] as const;

/** One of {@link MEMORY_RECALL_STOP_REASONS}. */
export type MemoryRecallStopReason = (typeof MEMORY_RECALL_STOP_REASONS)[number];

/**
 * What one recall may spend. `maxTokens` bounds the rendered evidence (four
 * characters to a token); `maxCost` counts embedder calls and recall detector
 * scans; `maxCandidates` bounds how many filtered candidates are scored, most
 * recent first; `maxIterations` bounds scoring passes, so a value above one
 * allows reformulation.
 */
export interface MemoryRetrievalBudgets {
  readonly maxTokens: number;
  readonly maxLatencyMilliseconds: number;
  readonly maxCost: number;
  readonly maxCandidates: number;
  readonly maxIterations: number;
}

/**
 * Constraints the constraint stages apply. `asOf` asks for what was current at
 * that time: a record observed later is left out, and a record superseded
 * after it is returned as historical. `entities` must all appear in a record's
 * content. `sources`, `runId`, and `purposes` restrict the record's persisted
 * source, owning run, and attributed purpose.
 */
export interface MemoryRetrievalConstraints {
  readonly asOf?: number;
  readonly entities: readonly string[];
  readonly sources: readonly MemorySourceKind[];
  readonly runId?: string;
  readonly purposes: readonly string[];
  /** Returns superseded records as historical evidence instead of leaving them out. */
  readonly includeHistorical: boolean;
}

/**
 * A versioned retrieval plan. Its `revision` is a digest of everything else in
 * it, so two recalls with the same revision ran the same plan, and a bundle
 * that records the revision can be replayed against it.
 */
export interface MemoryRetrievalPlan {
  readonly version: 1;
  readonly revision: string;
  readonly stages: readonly MemoryRetrievalStage[];
  readonly budgets: MemoryRetrievalBudgets;
  readonly constraints: MemoryRetrievalConstraints;
  /** Admission skips a candidate whose fused score is below this; `0` admits any. */
  readonly minimumScore: number;
  /** Cosine similarity at or above which an unselected record counts as conflicting with a selected one. */
  readonly conflictSimilarity: number;
}

/** The parts of a {@link MemoryRetrievalPlan} a caller may set; everything else takes its default. */
export interface MemoryRetrievalPlanInput {
  readonly stages?: readonly MemoryRetrievalStage[];
  readonly budgets?: Partial<MemoryRetrievalBudgets>;
  readonly constraints?: Partial<MemoryRetrievalConstraints>;
  readonly minimumScore?: number;
  readonly conflictSimilarity?: number;
}

/** The budgets a plan gets when its input names none. */
export const DEFAULT_MEMORY_RETRIEVAL_BUDGETS: MemoryRetrievalBudgets = Object.freeze({
  maxTokens: 2000,
  maxLatencyMilliseconds: 5000,
  maxCost: 64,
  maxCandidates: 1000,
  maxIterations: 2,
});

/** Thrown for a retrieval plan input no plan can satisfy. */
export class MemoryRetrievalPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryRetrievalPlanError';
  }
}

function validateBudgets(budgets: MemoryRetrievalBudgets): void {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isFinite(value) || value < 1) {
      throw new MemoryRetrievalPlanError(`Retrieval budget ${name} must be at least 1.`);
    }
  }
}

function orderedStages(stages: readonly MemoryRetrievalStage[]): MemoryRetrievalStage[] {
  for (const stage of stages) {
    if (!MEMORY_RETRIEVAL_STAGES.includes(stage)) {
      throw new MemoryRetrievalPlanError(`Unknown retrieval stage "${stage}".`);
    }
  }
  if (!stages.includes('exact-lexical') && !stages.includes('semantic')) {
    throw new MemoryRetrievalPlanError('A retrieval plan needs exact-lexical or semantic scoring.');
  }
  return MEMORY_RETRIEVAL_STAGES.filter((stage) => stages.includes(stage));
}

/**
 * Builds a versioned retrieval plan. Stages always run in
 * {@link MEMORY_RETRIEVAL_STAGES} order whatever order the input lists them
 * in, so the plan, and therefore its revision, does not depend on how the
 * caller spelled it.
 */
export function createMemoryRetrievalPlan(
  input: MemoryRetrievalPlanInput = {},
): MemoryRetrievalPlan {
  const stages = orderedStages(input.stages ?? MEMORY_RETRIEVAL_STAGES);
  const budgets = { ...DEFAULT_MEMORY_RETRIEVAL_BUDGETS, ...input.budgets };
  validateBudgets(budgets);
  const given = input.constraints ?? {};
  const constraints: MemoryRetrievalConstraints = {
    ...(given.asOf === undefined ? {} : { asOf: given.asOf }),
    entities: [...(given.entities ?? [])].map((entity) => entity.toLowerCase()).toSorted(),
    sources: [...(given.sources ?? [])].toSorted(),
    ...(given.runId === undefined ? {} : { runId: given.runId }),
    purposes: [...(given.purposes ?? [])].toSorted(),
    includeHistorical: given.includeHistorical ?? false,
  };
  const body = {
    version: 1 as const,
    stages,
    budgets,
    constraints,
    minimumScore: input.minimumScore ?? 0,
    conflictSimilarity: input.conflictSimilarity ?? 0.9,
  };
  return { ...body, revision: `sha256:${sha256HexSync(JSON.stringify(body))}` };
}

/** The plan a recall runs when its caller supplies none. */
export const DEFAULT_MEMORY_RETRIEVAL_PLAN: MemoryRetrievalPlan = createMemoryRetrievalPlan();
