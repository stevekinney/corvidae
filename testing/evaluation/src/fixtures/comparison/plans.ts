/**
 * `CollaborationPlan` documents for the comparison fixtures, in COR-820's
 * decided shape. Every builder returns a fresh plain-data object, so a test
 * that mutates one never leaks into another.
 *
 * The three profiles a comparison runs share one resource envelope, task,
 * task class, and policy version; only the execution profile, participants,
 * topology, and the governance that follows from them differ.
 */
export const POLICY_VERSION = 'collaboration-policy-2026-09';
export const TASK_REVISION = 'comparison-task-1';
export const SUCCESS_CONTRACT_REVISION = 'comparison-success-1';

export type PlanInput = Record<string, unknown>;

export interface ParticipantInput {
  readonly agentName: string;
  readonly role: 'producer' | 'verifier' | 'reducer' | 'mediator' | 'commit-authority';
}

export interface EdgeInput {
  readonly from: string;
  readonly to: string;
}

export function resourceEnvelope(): PlanInput {
  return {
    tokens: 20_000,
    costCents: 50,
    wallClockMilliseconds: 60_000,
    steps: 40,
    fanOut: 4,
    maximumDescendants: 4,
    toolAuthority: {
      grantedProviders: ['anthropic'],
      grantedModels: ['claude-sonnet-4-20250514'],
      maximumEffort: 'medium',
      policyVersion: POLICY_VERSION,
    },
  };
}

interface PlanOptions {
  readonly planId: string;
  readonly taskClass: unknown;
  readonly executionProfile: 'direct-agent' | 'compute-matched-ensemble' | 'collaboration';
  readonly participants: readonly ParticipantInput[];
  readonly commitAuthority: string;
  readonly edges?: readonly EdgeInput[];
  readonly permittedCycles?: number;
  /** False for an extension class, which authors its topology. */
  readonly defaultForClass?: boolean;
  readonly artifacts?: readonly PlanInput[];
  readonly contextProjections?: readonly PlanInput[];
  readonly stageVerifiers?: readonly PlanInput[];
}

/** One complete plan document. The parts no scenario varies are filled in here. */
export function planInput(options: PlanOptions): PlanInput {
  const { participants, commitAuthority } = options;
  return {
    planId: options.planId,
    planRevision: 1,
    policyVersion: POLICY_VERSION,
    task: { taskRevision: TASK_REVISION, successContractRevision: SUCCESS_CONTRACT_REVISION },
    taskClass: options.taskClass,
    executionProfile: options.executionProfile,
    resourceEnvelope: resourceEnvelope(),
    participants: participants.map((participant) => ({
      agentName: participant.agentName,
      capabilityEvidence: `evidence/${participant.agentName}`,
      role: participant.role,
      eligibilityReason: `${participant.agentName} is catalogued for the ${participant.role} role.`,
    })),
    topology: {
      defaultForClass: options.defaultForClass ?? true,
      permittedCycles: options.permittedCycles ?? 0,
      maximumRounds: 4,
      edges: (options.edges ?? []).map((edge) => ({
        ...edge,
        reason: `${edge.from} hands its result to ${edge.to}.`,
      })),
    },
    contextProjections: options.contextProjections ?? [],
    artifacts: options.artifacts ?? [],
    messageSchemas: [
      {
        schemaId: 'finding-1',
        appliesToIntents: ['observation', 'hypothesis', 'proposal', 'artifact', 'request'],
        definition: 'A finding: one claim about one subject.',
      },
      {
        schemaId: 'verdict-1',
        appliesToIntents: ['verification-result', 'rejection', 'commit', 'cancellation'],
        definition: 'A verdict over one subject, with the evidence digest it rests on.',
      },
    ],
    stageVerifiers: options.stageVerifiers ?? [],
    commitAuthority,
    stopConditions: ['The commit authority has committed the answer.'],
    fallback: { profile: 'direct-agent', reason: 'One strong agent is the floor.' },
    lifecycle: {
      ownership: 'parent-owned',
      executionMode: 'synchronous-inline',
      durability: 'process-local',
      cancellationOwner: commitAuthority,
    },
    security: {
      redactionPolicy: 'mask-message-content',
      auditRetentionDays: 30,
      emergencyDisableFlag: 'collaboration.admission.disabled',
      messageIntegrityBoundary: 'not-required',
    },
  };
}

/** The floor every other profile must beat: one Agent, no edges. */
export function directPlanInput(taskClass: unknown, agentName = 'solver'): PlanInput {
  return planInput({
    planId: 'direct-plan',
    taskClass,
    executionProfile: 'direct-agent',
    participants: [{ agentName, role: 'producer' }],
    commitAuthority: agentName,
  });
}

/**
 * The compute-matched control: independent samples, no messaging. With a
 * `reducer`, the reducer aggregates and commits; without one, a majority
 * vote aggregates and the first sampler commits the voted answer.
 */
export function ensemblePlanInput(
  taskClass: unknown,
  samplers: readonly string[],
  reducer?: string,
): PlanInput {
  const participants: ParticipantInput[] = samplers.map((agentName) => ({
    agentName,
    role: 'producer',
  }));
  if (reducer !== undefined) participants.push({ agentName: reducer, role: 'reducer' });
  return planInput({
    planId: 'ensemble-plan',
    taskClass,
    executionProfile: 'compute-matched-ensemble',
    participants,
    commitAuthority: reducer ?? (samplers[0] as string),
  });
}

/**
 * Partitioned search: three searchers each see one shard and report to one
 * reducer, which alone commits the answer artifact after the verifier
 * accepts it.
 */
export function partitionedSearchPlanInput(): PlanInput {
  const searchers = ['searcher-a', 'searcher-b', 'searcher-c'];
  return planInput({
    planId: 'partitioned-search-plan',
    taskClass: 'partitioned-search',
    executionProfile: 'collaboration',
    participants: [
      ...searchers.map((agentName): ParticipantInput => ({ agentName, role: 'producer' })),
      { agentName: 'reducer', role: 'reducer' },
    ],
    commitAuthority: 'reducer',
    edges: searchers.map((from) => ({ from, to: 'reducer' })),
    contextProjections: searchers.map((participant, index) => ({
      participant,
      sources: [{ kind: 'artifact', id: `shard-${'abc'[index]}`, revision: '1' }],
      requiredSources: [`shard-${'abc'[index]}`],
    })),
    artifacts: [
      {
        artifactId: 'answer',
        schema: 'finding-1',
        owner: 'reducer',
        readers: ['reducer'],
        writers: ['reducer'],
        revision: 0,
        freshnessRule: 'Every searcher finding is newer than the shard revision it read.',
        conflictBehavior: 'reject-stale',
        commitAuthority: 'reducer',
      },
    ],
  });
}

/** A proposed collaboration for a task one Agent can already do alone: the negative control. */
export function directCollaborationPlanInput(): PlanInput {
  return planInput({
    planId: 'direct-collaboration-plan',
    taskClass: 'direct',
    executionProfile: 'collaboration',
    participants: [
      { agentName: 'drafter', role: 'producer' },
      { agentName: 'finisher', role: 'commit-authority' },
    ],
    commitAuthority: 'finisher',
    edges: [{ from: 'drafter', to: 'finisher' }],
  });
}

/**
 * Shared state: two clerks propose updates to one authoritative count that
 * only the ledger keeper commits.
 */
export function sharedStatePlanInput(): PlanInput {
  return planInput({
    planId: 'shared-state-plan',
    taskClass: 'shared-state',
    executionProfile: 'collaboration',
    participants: [
      { agentName: 'clerk-one', role: 'producer' },
      { agentName: 'clerk-two', role: 'producer' },
      { agentName: 'keeper', role: 'commit-authority' },
    ],
    commitAuthority: 'keeper',
    edges: [
      { from: 'clerk-one', to: 'keeper' },
      { from: 'clerk-two', to: 'keeper' },
    ],
    artifacts: [
      {
        artifactId: 'inventory-count',
        schema: 'finding-1',
        owner: 'keeper',
        readers: ['clerk-one', 'clerk-two', 'keeper'],
        writers: ['clerk-one', 'clerk-two', 'keeper'],
        revision: 0,
        freshnessRule: 'A proposal names the count revision it read.',
        conflictBehavior: 'reject-stale',
        commitAuthority: 'keeper',
      },
    ],
  });
}

/** Verifier-driven revision: a bounded producer-verifier cycle with a terminal path. */
export function verifierRevisionPlanInput(): PlanInput {
  return planInput({
    planId: 'verifier-revision-plan',
    taskClass: 'verifier-revision',
    executionProfile: 'collaboration',
    participants: [
      { agentName: 'writer', role: 'producer' },
      { agentName: 'counter', role: 'verifier' },
    ],
    commitAuthority: 'writer',
    permittedCycles: 2,
    edges: [
      { from: 'writer', to: 'counter' },
      { from: 'counter', to: 'writer' },
    ],
    stageVerifiers: [
      {
        stageId: 'draft',
        boundAt: 'handoff-creation',
        acceptanceCriteria: 'The sentence has exactly seven words.',
        rejector: ['counter'],
        onFailure: 'retry',
        retryBudget: 2,
      },
    ],
  });
}

/**
 * A collaboration for a named extension class, which authors its own topology
 * and must give a reason for it: every participant a producer, and the first
 * one the commit authority.
 */
export function extensionPlanInput(
  participants: readonly string[],
  edges: readonly EdgeInput[],
  permittedCycles: number,
): PlanInput {
  return planInput({
    planId: 'extension-plan',
    taskClass: {
      extension: 'dense-review',
      reason: 'Every reviewer may hand its review to every other reviewer.',
    },
    executionProfile: 'collaboration',
    participants: participants.map((agentName) => ({ agentName, role: 'producer' })),
    commitAuthority: participants[0] as string,
    edges,
    permittedCycles,
    defaultForClass: false,
  });
}

/** An extension collaboration of `size` reviewers, each of which may hand work to every other. */
export function fullyConnectedPlanInput(size: number): PlanInput {
  const reviewers = Array.from({ length: size }, (_, index) => `reviewer-${index + 1}`);
  const edges = reviewers.flatMap((from) =>
    reviewers.filter((to) => to !== from).map((to) => ({ from, to })),
  );
  return extensionPlanInput(reviewers, edges, 3);
}
