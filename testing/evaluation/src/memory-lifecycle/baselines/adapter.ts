/**
 * The contract every memory baseline implements (COR-755). The harness
 * drives a baseline through one scenario's timeline with `observe`,
 * `forget`, and `restart`, and the scenario agent's `memory_recall` tool
 * reads from it with `recall`, always as the owner. A baseline never sees a
 * scenario's labels or expected outcome: it receives what a deployment would
 * receive, and reports what it did.
 *
 * The four baselines, simplest first:
 *
 * - `no-memory` retains nothing.
 * - `raw-log-search` appends every observation to a durable log and answers
 *   with authorized lexical search over the owner's own entries.
 * - `flat-hybrid` is the current `@lostgradient/memory` store as one agent
 *   deploys it: `createMemory` with one namespace per tenant's agent.
 * - `lifecycle` is the proposed architecture: COR-41's governed memory, plus
 *   the structured components the report decides whether to promote.
 */
import type { RuntimeServices } from '@lostgradient/operative';

import type { ComputeEnvelope } from '../envelope';
import type { EvidenceSource, ScenarioEvidence, ScenarioPrincipal } from '../scenarios';

/** An observation as a deployment receives it: everything but the scenario's ground-truth label. */
export type ObservedEvidence = Omit<ScenarioEvidence, 'label'>;

export const MEMORY_BASELINES = [
  'no-memory',
  'raw-log-search',
  'flat-hybrid',
  'lifecycle',
] as const;
export type MemoryBaselineName = (typeof MEMORY_BASELINES)[number];

/** Each baseline's adapter revision; a behavior change to an adapter is a new revision. */
export const BASELINE_REVISIONS: Readonly<Record<MemoryBaselineName, string>> = {
  'no-memory': 'no-memory-1',
  'raw-log-search': 'raw-log-search-1',
  'flat-hybrid': 'flat-hybrid-1',
  lifecycle: 'lifecycle-1',
};

/** Every baseline but the proposed one; the gate compares against the best of these. */
export const SIMPLER_BASELINES = [
  'no-memory',
  'raw-log-search',
  'flat-hybrid',
] as const satisfies readonly MemoryBaselineName[];

/**
 * What a baseline did with one observation. `not-retained` means it keeps no
 * memory at all; a baseline that keeps memory reports how admission ruled.
 */
export type AdmissionOutcome =
  'admitted' | 'quarantined' | 'rejected' | 'duplicate' | 'not-retained';

/**
 * What a baseline reports for one deletion request, in COR-806's receipt
 * vocabulary where it has one. `exempt` means a legal hold kept the record.
 * `receipted` says whether the baseline issued a durable receipt at all;
 * `completed` without one is the baseline's own report, which the scorer
 * still checks against what recall returns.
 */
export interface DeletionOutcome {
  readonly status:
    'completed' | 'pending' | 'exempt' | 'failed' | 'unknown' | 'not-found' | 'not-retained';
  readonly receipted: boolean;
}

export interface RecallRequest {
  readonly query: string;
  readonly limit: number;
}

/** One recalled record, as the agent sees it. */
export interface RecalledItem {
  readonly content: string;
  /** When the evidence was observed, when the baseline kept that. */
  readonly observedAt: string | null;
  /** Where the evidence came from, when the baseline kept that. */
  readonly source: EvidenceSource | null;
}

/** How a baseline answered one recall, for the retrieval-plan revision. */
export interface RetrievalPlan {
  readonly strategy: string;
  /** Whose memory the recall searched. */
  readonly scope: string;
  readonly query: string;
  readonly limit: number;
}

export interface RecallResult {
  readonly plan: RetrievalPlan;
  readonly items: readonly RecalledItem[];
  /** Records the baseline found but withheld from the model. */
  readonly withheld: number;
}

export interface MemoryBaselineAdapter {
  readonly name: MemoryBaselineName;
  /** The adapter's own revision, from {@link BASELINE_REVISIONS}. */
  readonly revision: string;
  /** The structured components this baseline runs, for the promotion report. */
  readonly components: readonly StructuredComponent[];
  observe(evidence: ObservedEvidence): Promise<AdmissionOutcome>;
  /** The owner asks for `evidenceId` to be deleted. */
  forget(evidenceId: string): Promise<DeletionOutcome>;
  /** In-process state is lost; durable storage survives. */
  restart(): Promise<void>;
  /** Recalls as the owner. */
  recall(request: RecallRequest): Promise<RecallResult>;
  close(): Promise<void>;
}

/**
 * The lifecycle architecture's structured components. Each has a target
 * workload; the report promotes one only where the architecture beats
 * raw-log search there and also does better than it does without that one
 * component.
 */
export const STRUCTURED_COMPONENTS = [
  'state-projector',
  'procedure-memory',
  'resource-derivation',
] as const;
export type StructuredComponent = (typeof STRUCTURED_COMPONENTS)[number];

/** The structured components each baseline runs unless an ablation removes some; only the lifecycle architecture has any. */
export const BASELINE_COMPONENTS: Readonly<
  Record<MemoryBaselineName, readonly StructuredComponent[]>
> = {
  'no-memory': [],
  'raw-log-search': [],
  'flat-hybrid': [],
  lifecycle: STRUCTURED_COMPONENTS,
};

/**
 * The components `baseline` runs when `requested` are asked for: those of
 * them it has, in their canonical order. By default, all of the ones it has.
 */
export function baselineComponents(
  baseline: MemoryBaselineName,
  requested: readonly StructuredComponent[] = BASELINE_COMPONENTS[baseline],
): StructuredComponent[] {
  return BASELINE_COMPONENTS[baseline].filter((component) => requested.includes(component));
}

/**
 * What a run of `baseline` with `components` is called: the baseline's own
 * name when it runs every component it has, and
 * `<baseline>-without-<component>` for an ablation that removes some.
 * Artifact ids, evaluation-run record ids, and the evaluator's environment
 * all carry it, so an ablation never shares an identity with the full
 * architecture.
 */
export function baselineVariant(
  baseline: MemoryBaselineName,
  components: readonly StructuredComponent[],
): string {
  const removed = BASELINE_COMPONENTS[baseline].filter(
    (component) => !components.includes(component),
  );
  return removed.length === 0 ? baseline : `${baseline}-without-${removed.join('-and-')}`;
}

export interface BaselineOptions {
  /** The scenario's deterministic runtime; the harness moves its clock to each event. */
  readonly runtime: RuntimeServices;
  readonly envelope: ComputeEnvelope;
  /**
   * The structured components to run, for an ablation. Defaults to every
   * component the baseline has; a baseline without components ignores it.
   */
  readonly components?: readonly StructuredComponent[] | undefined;
}

/** Where a principal's memory lives: its tenant, and the owner partition it acts for. */
export interface PrincipalScope {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly principalId: string;
}

/**
 * The deployment every scenario runs in. The owner, the owner's support
 * operator, and a co-user share tenant A and its one support agent; the
 * co-user is a different owner. Another tenant has its own agent.
 */
export const PRINCIPAL_SCOPES: Readonly<Record<ScenarioPrincipal, PrincipalScope>> = {
  owner: { tenantId: 'tenant-a', ownerId: 'owner-a', principalId: 'customer-a' },
  operator: { tenantId: 'tenant-a', ownerId: 'owner-a', principalId: 'support-operator' },
  'co-user': { tenantId: 'tenant-a', ownerId: 'owner-b', principalId: 'customer-b' },
  'other-tenant': { tenantId: 'tenant-b', ownerId: 'owner-c', principalId: 'customer-c' },
};

/** How much a source is trusted to state the owner's facts, highest first in rank. */
export const SOURCE_RANK: Readonly<Record<EvidenceSource, number>> = {
  operator: 2,
  conversation: 1,
  'tool-result': 0,
  'ingested-document': 0,
};

/** An ISO-8601 instant for an epoch-millisecond time. */
export function instantOf(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}
