import { sha256HexSync } from '@lostgradient/cryptography';

import { extractKeywords } from '../query-expansion';
import type { MemoryAuthority } from './authority';
import { scanGovernedContent } from './content-scan';
import { type MemoryEvidence, renderMemoryEvidence } from './evidence';
import type { GovernanceContext } from './governance-context';
import type {
  MemoryEvidenceBundle,
  MemoryRecallContradiction,
  MemoryRecallExclusion,
  MemoryRecallExclusionReason,
  MemoryRecallFilterReport,
  MemoryRecallStageReport,
  MemoryRecallStageScores,
  RecallForModelOptions,
} from './governed-memory-types';
import { capabilityAllowed, evictionContext, scopesFor } from './governed-reads';
import type { MemoryGovernancePolicy } from './policy';
import {
  type FilteredCandidates,
  type FilterInput,
  filterRecallCandidates,
  type RecallCandidate,
  recallExclusion,
  resolveLineageSource,
} from './recall-candidates';
import { candidateSimilarity, scoreCandidates, type ScoredCandidate } from './recall-scoring';
import {
  createMemoryRetrievalPlan,
  DEFAULT_MEMORY_RETRIEVAL_PLAN,
  type MemoryRecallStopReason,
  type MemoryRetrievalPlan,
  type MemoryRetrievalStage,
} from './retrieval-plan';

/** The exclusion reasons recall admission counts as withheld. */
const WITHHELD: ReadonlySet<MemoryRecallExclusionReason> = new Set([
  'evicted',
  'trust-below-minimum',
  'retention-expired',
  'content-policy',
]);

const CONSTRAINT_STAGES: readonly MemoryRetrievalStage[] = [
  'temporal-filter',
  'entity-filter',
  'source-session-constraint',
];

/** Everything a recall decides as it runs, assembled into the bundle when it stops. */
interface RecallRun {
  readonly context: GovernanceContext;
  readonly authority: MemoryAuthority;
  readonly options: RecallForModelOptions;
  readonly plan: MemoryRetrievalPlan;
  readonly operationId: string;
  readonly startedAt: number;
  readonly limit: number;
  /** The one policy snapshot every filter, detector, and recorded revision of this recall uses. */
  readonly policy: MemoryGovernancePolicy;
  readonly evidence: MemoryEvidence[];
  readonly selected: Map<string, RecallCandidate>;
  readonly scores: Map<string, MemoryRecallStageScores>;
  readonly exclusions: MemoryRecallExclusion[];
  readonly stages: Map<MemoryRetrievalStage, MemoryRecallStageReport>;
  readonly reformulations: string[];
  readonly contradictions: MemoryRecallContradiction[];
  readonly conflicting: Set<string>;
  filtered?: FilteredCandidates;
  filterInput?: FilterInput;
  /** Lineage sources resolved from outside the recalled collection, reported beside its own candidates. */
  readonly expanded: RecallCandidate[];
  filters: readonly MemoryRecallFilterReport[];
  cost: number;
  tokens: number;
  iterations: number;
  considered: number;
  stopReason: MemoryRecallStopReason | undefined;
}

/**
 * The plan to run, always rebuilt from its fields: a caller-held plan whose
 * fields were changed after it was built, or an object that only claims a
 * revision, runs as what it says and is recorded under that plan's true revision.
 */
function resolvePlan(plan: RecallForModelOptions['plan']): MemoryRetrievalPlan {
  if (plan === undefined) return DEFAULT_MEMORY_RETRIEVAL_PLAN;
  const { stages, budgets, constraints, minimumScore, conflictSimilarity } = plan;
  return createMemoryRetrievalPlan({
    ...(stages === undefined ? {} : { stages }),
    ...(budgets === undefined ? {} : { budgets }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(minimumScore === undefined ? {} : { minimumScore }),
    ...(conflictSimilarity === undefined ? {} : { conflictSimilarity }),
  });
}

function digest(text: string): string {
  return `sha256:${sha256HexSync(text)}`;
}

function report(
  run: RecallRun,
  stage: MemoryRetrievalStage,
  status: MemoryRecallStageReport['status'],
  detail?: string,
): void {
  if (!run.plan.stages.includes(stage)) return;
  run.stages.set(stage, { stage, status, ...(detail === undefined ? {} : { detail }) });
}

/** Records a stop reason when none is recorded yet, and reports whether the recall must stop now. */
function stopped(run: RecallRun): boolean {
  if (run.stopReason !== undefined) return true;
  if (run.options.signal?.aborted === true) run.stopReason = 'canceled';
  else if (run.context.now() - run.startedAt > run.plan.budgets.maxLatencyMilliseconds) {
    run.stopReason = 'exhausted';
  }
  return run.stopReason !== undefined;
}

function evidenceFrom(candidate: RecallCandidate, score: number): MemoryEvidence {
  const { governance } = candidate.read;
  return {
    id: candidate.record.id,
    label: 'evidence',
    authority: 'none',
    kind: candidate.kind,
    content: candidate.record.content,
    trust: governance.trust,
    source: governance.source,
    memoryClass: governance.memoryClass,
    visibility: governance.visibility,
    score,
    contentDigest: governance.contentDigest,
  };
}

async function withholdPoisoned(
  run: RecallRun,
  candidate: RecallCandidate,
  scan: { detector: string; category: string; confidence: number },
): Promise<void> {
  const { context, authority } = run;
  await context.updateGovernance(candidate, (governance) =>
    governance.state === 'active' ? { state: 'quarantined' } : undefined,
  );
  await context.textSearchProvider?.remove(candidate.record.id);
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.recall.withheld',
    outcome: 'quarantined',
    attribution: context.attribution(authority, run.operationId),
    recordIds: [candidate.record.id],
    reason: 'content-policy',
    diagnostic: { ...scan, contentDigest: candidate.read.governance.contentDigest },
  });
}

/**
 * Admits one ranked candidate: within the token and cost budgets, and past the
 * recall detectors, which quarantine content that trips them. Returns the stop
 * reason when a budget ends the recall.
 */
async function admitOne(
  run: RecallRun,
  candidate: RecallCandidate,
  score: number,
): Promise<MemoryRecallStopReason | undefined> {
  const { budgets } = run.plan;
  // The whole prospective rendering counts, envelope and preamble included,
  // because that is what reaches the model.
  const tokens = Math.ceil(
    renderMemoryEvidence([...run.evidence, evidenceFrom(candidate, score)]).length / 4,
  );
  if (tokens > budgets.maxTokens) {
    return run.evidence.length > 0 ? 'sufficient' : 'exhausted';
  }
  const { policy } = run;
  if (policy.recall.detectors.length > 0) {
    if (run.cost + 1 > budgets.maxCost) return 'exhausted';
    run.cost += 1;
  }
  const provenance =
    candidate.read.governance.source === 'ingested-document'
      ? 'ingested-document'
      : 'recalled-memory';
  const scan = await scanGovernedContent(
    candidate.record.content,
    policy.recall.detectors,
    provenance,
  );
  if (scan.flagged) {
    const { flagged: _flagged, ...diagnostic } = scan;
    await withholdPoisoned(run, candidate, diagnostic);
    run.exclusions.push(recallExclusion(candidate, 'admission', 'content-policy'));
    return undefined;
  }
  // The scan awaited: a cancellation or the latency budget may have ended the recall meanwhile.
  if (stopped(run)) return run.stopReason;
  run.tokens = tokens;
  run.selected.set(candidate.record.id, candidate);
  run.evidence.push(evidenceFrom(candidate, score));
  return undefined;
}

/** Admits ranked candidates in order until the limit or a budget stops it; returns those below the minimum score. */
async function admitRanked(
  run: RecallRun,
  ranked: readonly ScoredCandidate[],
): Promise<RecallCandidate[]> {
  const below: RecallCandidate[] = [];
  for (const { candidate, scores } of ranked) {
    run.scores.set(candidate.record.id, scores);
    if (run.evidence.length >= run.limit) {
      run.stopReason = 'sufficient';
      continue;
    }
    if (run.stopReason !== undefined || stopped(run)) continue;
    if (run.plan.minimumScore > 0 && scores.fused < run.plan.minimumScore) {
      below.push(candidate);
      continue;
    }
    run.stopReason = await admitOne(run, candidate, scores.fused);
  }
  return below;
}

/** The next reformulation of `query`, or `undefined` once there is nothing new to try. */
function reformulate(query: string, tried: readonly string[]): string | undefined {
  const keywords = extractKeywords(query).join(' ');
  if (keywords.length === 0 || keywords === query || tried.includes(keywords)) return undefined;
  return keywords;
}

/**
 * The scoring passes: the query, then each reformulation over the candidates
 * still below the minimum. Returns the candidates no pass lifted above it.
 */
async function scoringPasses(
  run: RecallRun,
  query: string,
  candidates: readonly RecallCandidate[],
): Promise<readonly RecallCandidate[]> {
  let pending = candidates;
  let current = query;
  while (!stopped(run)) {
    if (run.plan.stages.includes('semantic') && run.cost + 1 > run.plan.budgets.maxCost) {
      run.stopReason = 'exhausted';
      break;
    }
    run.iterations += 1;
    let pass: Awaited<ReturnType<typeof scoreCandidates>>;
    try {
      pass = await scoreCandidates(run.context, run.plan, current, pending);
    } catch {
      // The embedder or text-search provider failed: the recall fails closed
      // with no evidence, and nothing an earlier pass selected stays selected.
      // A ledger failure is not caught, so it still escapes.
      run.stopReason = 'failed';
      run.evidence.length = 0;
      run.selected.clear();
      run.tokens = 0;
      return pending;
    }
    run.cost += pass.cost;
    pending = await admitRanked(run, pass.ranked);
    const next =
      pending.length === 0 ||
      run.stopReason !== undefined ||
      !run.plan.stages.includes('reformulation') ||
      run.iterations >= run.plan.budgets.maxIterations
        ? undefined
        : reformulate(query, run.reformulations);
    if (next === undefined) break;
    run.reformulations.push(next);
    current = next;
  }
  report(
    run,
    'reformulation',
    run.reformulations.length > 0 ? 'applied' : 'skipped',
    run.reformulations.length > 0 ? undefined : 'no candidate fell below the minimum score',
  );
  return pending;
}

/** Pulls the sources of each selected derived record in, when they passed every filter themselves. */
async function expandProvenance(run: RecallRun): Promise<void> {
  if (!run.plan.stages.includes('provenance-expansion')) return;
  const eligible = new Map(run.filtered!.eligible.map((item) => [item.record.id, item]));
  const listed = new Set(run.filtered!.authorized.map((item) => item.record.id));
  let expanded = 0;
  for (const selected of run.selected.values()) {
    for (const source of selected.read.governance.lineage?.sources ?? []) {
      if (run.selected.has(source.id)) continue;
      // A source admission already withheld (a detector quarantined it, or a
      // budget left it out) is never offered to admission a second time.
      if (run.exclusions.some((exclusion) => exclusion.recordId === source.id)) continue;
      // A source in the recalled collection already went through every filter;
      // one stored elsewhere is resolved and filtered by the same rules here.
      const candidate = listed.has(source.id)
        ? eligible.get(source.id)
        : await resolveLineageSource(run.filterInput!, source);
      if (candidate === undefined) continue;
      if (!listed.has(source.id)) run.expanded.push(candidate);
      if (run.evidence.length >= run.limit || stopped(run)) break;
      const before = run.evidence.length;
      run.stopReason = await admitOne(run, candidate, 0);
      if (run.evidence.length > before) expanded += 1;
    }
  }
  report(
    run,
    'provenance-expansion',
    expanded > 0 ? 'applied' : 'skipped',
    expanded > 0 ? undefined : 'no selected record has an eligible source left to add',
  );
}

/** Records what disagrees with each selected record: its superseded predecessors, and near-duplicates that differ. */
function findCounterevidence(run: RecallRun): void {
  if (!run.plan.stages.includes('counterevidence')) return;
  const filtered = run.filtered!;
  for (const selected of run.selected.values()) {
    for (const predecessor of filtered.superseded) {
      if (predecessor.read.governance.supersededBy !== selected.record.id) continue;
      run.contradictions.push({
        recordId: predecessor.record.id,
        contradicts: selected.record.id,
        kind: 'historical-projection',
      });
    }
    for (const other of filtered.eligible) {
      if (run.selected.has(other.record.id)) continue;
      if (other.read.governance.contentDigest === selected.read.governance.contentDigest) continue;
      if (candidateSimilarity(selected, other) < run.plan.conflictSimilarity) continue;
      run.conflicting.add(other.record.id);
      run.contradictions.push({
        recordId: other.record.id,
        contradicts: selected.record.id,
        kind: 'conflicting-candidate',
      });
    }
  }
  report(run, 'counterevidence', run.contradictions.length > 0 ? 'applied' : 'skipped');
}

/** Runs the plan's stages in order over the caller's authorized candidates. */
async function executePlan(run: RecallRun, query: string): Promise<void> {
  const { context, authority, options, plan } = run;
  if (stopped(run)) return;
  const evicted = new Set(
    options.contextId === undefined
      ? []
      : await context.ledger.listEvictions(
          authority.tenantId,
          evictionContext(authority, options.contextId),
        ),
  );
  const scopes = scopesFor(context, authority, options.collection, options.visibility ?? 'all');
  const filterInput: FilterInput = {
    context,
    policy: run.policy,
    authority,
    options,
    plan,
    evicted,
  };
  const filtered = await filterRecallCandidates(filterInput, scopes);
  run.filterInput = filterInput;
  run.filtered = filtered;
  run.filters = filtered.filters;
  run.exclusions.push(...filtered.exclusions);
  for (const stage of CONSTRAINT_STAGES) {
    const applied = filtered.constraintStages.has(stage);
    report(
      run,
      stage,
      applied ? 'applied' : 'skipped',
      applied ? undefined : 'no constraint given',
    );
  }
  const byRecency = filtered.eligible.toSorted(
    (left, right) => right.read.governance.eventAt - left.read.governance.eventAt,
  );
  const budgeted = byRecency.slice(0, plan.budgets.maxCandidates);
  for (const candidate of byRecency.slice(plan.budgets.maxCandidates)) {
    run.exclusions.push(recallExclusion(candidate, 'budget', 'candidate-budget'));
  }
  run.considered = budgeted.length;
  for (const stage of ['exact-lexical', 'semantic', 'rank-fusion'] as const) {
    report(run, stage, budgeted.length > 0 ? 'applied' : 'skipped');
  }
  const below = await scoringPasses(run, query, budgeted);
  await expandProvenance(run);
  for (const candidate of below) {
    if (run.selected.has(candidate.record.id)) continue;
    run.exclusions.push(recallExclusion(candidate, 'admission', 'below-minimum-score'));
  }
  report(
    run,
    'context-expansion',
    'unavailable',
    'governed memory stores no raw-evidence chunks to expand a record into',
  );
  findCounterevidence(run);
}

function selectionOf(run: RecallRun, excluded: ReadonlySet<string>, id: string) {
  if (run.selected.has(id)) return 'selected' as const;
  return excluded.has(id) ? ('excluded' as const) : ('not-reached' as const);
}

/** Assembles the bundle and records the admission in the governance ledger. */
async function finish(
  run: RecallRun,
  query: string,
  recordAdmission: boolean,
): Promise<MemoryEvidenceBundle> {
  const { context, authority, plan } = run;
  const stopReason =
    run.stopReason ?? (run.evidence.length >= run.limit ? 'sufficient' : 'exhausted');
  const evidence = stopReason === 'failed' ? [] : run.evidence;
  const rendered = renderMemoryEvidence(evidence);
  const policyRevision = run.policy.revision;
  const queryDigest = digest(query);
  const contentDigest = digest(rendered);
  const withheld = run.exclusions.filter((exclusion) => WITHHELD.has(exclusion.reason)).length;
  const revision = digest(
    JSON.stringify([
      plan.revision,
      policyRevision,
      queryDigest,
      evidence.map((item) => [item.id, run.selected.get(item.id)?.revision, item.kind]),
      run.exclusions.map((exclusion) => [exclusion.recordId, exclusion.revision, exclusion.reason]),
    ]),
  );
  const excluded = new Set(run.exclusions.map((exclusion) => exclusion.recordId));
  const now = context.now();
  if (recordAdmission) {
    await context.recordEvent({
      tenantId: authority.tenantId,
      type: 'memory.recall.admitted',
      outcome: 'admitted',
      attribution: context.attribution(authority, run.operationId),
      recordIds: evidence.map((item) => item.id),
      details: {
        withheld,
        stopReason,
        planRevision: plan.revision,
        bundleRevision: revision,
        queryDigest,
        contentDigest,
      },
    });
  }
  return {
    operationId: run.operationId,
    evidence,
    withheld,
    rendered,
    revision,
    plan,
    planRevision: plan.revision,
    policyRevision,
    queryDigest,
    stopReason,
    candidates: [...(run.filtered?.authorized ?? []), ...run.expanded].map((candidate) => {
      const scores = run.scores.get(candidate.record.id);
      return {
        recordId: candidate.record.id,
        revision: candidate.revision,
        kind: run.conflicting.has(candidate.record.id) ? 'conflicting-candidate' : candidate.kind,
        selection: selectionOf(run, excluded, candidate.record.id),
        ...(scores === undefined ? {} : { scores }),
      };
    }),
    exclusions: run.exclusions,
    filters: run.filters,
    stages: plan.stages.flatMap((stage) => run.stages.get(stage) ?? []),
    reformulations: run.reformulations,
    contradictions: run.contradictions,
    redactions: evidence.map((item) => ({
      recordId: item.id,
      redaction: run.selected.get(item.id)!.redaction,
    })),
    freshness: evidence.map((item) => {
      const { record, read } = run.selected.get(item.id)!;
      return {
        recordId: item.id,
        eventAt: read.governance.eventAt,
        updatedAt: record.updatedAt,
        ageMilliseconds: now - read.governance.eventAt,
      };
    }),
    spent: {
      tokens: run.tokens,
      latencyMilliseconds: now - run.startedAt,
      cost: run.cost,
      candidates: run.considered,
      iterations: run.iterations,
    },
    contentDigest,
  };
}

/**
 * Mandatory recall admission: the only recall path whose output is meant for a
 * model. It runs a versioned retrieval plan. The policy filters and constraint
 * stages run first, on every candidate the caller may read, so nothing is
 * scored until it is authorized, in policy, and in scope: a record is withheld
 * before scoring when it was evicted from this context, its trust is below the
 * policy minimum for its class (an untrusted procedure is never selected), or
 * its retention has ended. The survivors are scored, fused, and admitted in rank
 * order, so a withheld record never shrinks the evidence returned; a recall
 * detector that trips on one withholds and quarantines it. The model receives
 * only labeled evidence; the bundle tells the caller why.
 */
export async function recallForModel(
  context: GovernanceContext,
  authority: MemoryAuthority,
  query: string,
  options: RecallForModelOptions,
): Promise<MemoryEvidenceBundle> {
  const run: RecallRun = {
    context,
    authority,
    options,
    plan: resolvePlan(options.plan),
    operationId: context.operationId(),
    startedAt: context.now(),
    limit: options.limit ?? 5,
    policy: context.policy(),
    evidence: [],
    selected: new Map(),
    scores: new Map(),
    exclusions: [],
    stages: new Map(),
    reformulations: [],
    contradictions: [],
    conflicting: new Set(),
    expanded: [],
    filters: [],
    cost: 0,
    tokens: 0,
    iterations: 0,
    considered: 0,
    stopReason: undefined,
  };
  if (
    options.collection.length === 0 ||
    !(await capabilityAllowed(context, authority, 'search', run.operationId))
  ) {
    run.stopReason = 'unavailable';
    return finish(run, query, false);
  }
  await executePlan(run, query);
  return finish(run, query, true);
}
