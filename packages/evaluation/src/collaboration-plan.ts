/**
 * The `CollaborationPlan` (COR-820, "CollaborationPlan schema"): a
 * serializable, versioned document that says how one task is executed and
 * governed. A comparison mints one plan per execution profile, so the direct
 * Agent, the compute-matched ensemble, and the proposed collaboration are
 * each a record on their own side of the admission comparison.
 *
 * This module is the plan's TypeScript and runtime representation, validated
 * with Zod exactly as COR-820 decided it, plus the structural rules that
 * decision states in prose:
 *
 * - participant identity is `agentName` plus `capabilityEvidence`; there is
 *   no `agentRevision` (owner ruling, 2026-09-19);
 * - every reference to a participant (edges, projections, artifact owners,
 *   readers, writers, and commit authorities, stage rejectors, the plan's
 *   commit authority, and the cancellation owner) names a declared one;
 * - a projection's required sources are among its named sources, so a
 *   missing one can fail the handoff instead of becoming a partial task;
 * - stage verifiers are bound at handoff creation, and nothing later;
 * - cycles are permitted only for verifier-driven revision or an explicitly
 *   named extension, and an edge graph with a cycle must permit one; a
 *   verifier-revision collaboration must permit one and bind a stage
 *   verifier (its direct and ensemble controls have no cycle to bound);
 * - an extension class authors its topology rather than inheriting one;
 * - a direct-agent plan is one participant with no edges, and a shared-state
 *   collaboration declares its authoritative state;
 * - the fallback is always one strong direct Agent.
 *
 * Tool authority is operative's `DelegatedAuthority`, reused rather than
 * re-specified; the schema below is checked against that type at compile
 * time. Nothing here dispatches a plan: this package only evaluates plans.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import type { DelegatedAuthority, ProviderName } from '@lostgradient/operative';
import { z } from 'zod';

import {
  EFFORTS,
  EvaluatorConfigurationError,
  identifier,
  reportDuplicates,
  toConfigurationIssues,
} from './configuration';
import { canonicalJson } from './identity';

export const TASK_CLASSES = [
  'direct',
  'independent-sampling',
  'partitioned-search',
  'sequential-dependency',
  'shared-state',
  'verifier-revision',
] as const;

export type NamedTaskClass = (typeof TASK_CLASSES)[number];

export const EXECUTION_PROFILES = [
  'direct-agent',
  'compute-matched-ensemble',
  'collaboration',
] as const;

export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

export const MESSAGE_INTENTS = [
  'observation',
  'hypothesis',
  'request',
  'proposal',
  'artifact',
  'verification-result',
  'commit',
  'rejection',
  'cancellation',
] as const;

export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

export const PARTICIPANT_ROLES = [
  'producer',
  'verifier',
  'reducer',
  'mediator',
  'commit-authority',
] as const;

export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

const PROVIDER_NAMES = [
  'anthropic',
  'openai',
  'gemini',
  'voyage',
  'ollama',
] as const satisfies readonly ProviderName[];
// Fails to compile if operative adds a provider this list does not name.
const PROVIDER_NAMES_ARE_EXHAUSTIVE: Exclude<
  ProviderName,
  (typeof PROVIDER_NAMES)[number]
> extends never
  ? true
  : never = true;
void PROVIDER_NAMES_ARE_EXHAUSTIVE;

export const taskClassSchema = z.union([
  z.enum(TASK_CLASSES),
  z.strictObject({ extension: identifier, reason: identifier }),
]);

export type TaskClass = z.output<typeof taskClassSchema>;

/** True for an explicitly named extension class. */
export function isExtensionTaskClass(
  taskClass: TaskClass,
): taskClass is Extract<TaskClass, { readonly extension: string }> {
  return typeof taskClass !== 'string';
}

/** One string per task class: the class name, or `extension:<name>`. */
export function taskClassKey(taskClass: TaskClass): string {
  return isExtensionTaskClass(taskClass) ? `extension:${taskClass.extension}` : taskClass;
}

/** Operative's `DelegatedAuthority`, as a plan serializes it. */
const delegatedAuthoritySchema = z.strictObject({
  grantedProviders: z.array(z.enum(PROVIDER_NAMES)).optional(),
  grantedModels: z.array(identifier).optional(),
  maximumEffort: z.enum(EFFORTS).optional(),
  policyVersion: identifier,
});
// Fails to compile if a parsed grant stops being operative's `DelegatedAuthority`.
const GRANT_IS_DELEGATED_AUTHORITY: z.output<
  typeof delegatedAuthoritySchema
> extends DelegatedAuthority
  ? true
  : never = true;
void GRANT_IS_DELEGATED_AUTHORITY;

const count = z.number().int().min(0);

const participantSchema = z.strictObject({
  agentName: identifier,
  /** A pointer into stored evaluation evidence, never an inline transcript. */
  capabilityEvidence: identifier,
  role: z.enum(PARTICIPANT_ROLES),
  eligibilityReason: identifier,
});

const edgeSchema = z.strictObject({ from: identifier, to: identifier, reason: identifier });

const contextProjectionSchema = z.strictObject({
  participant: identifier,
  sources: z.array(
    z.strictObject({
      kind: z.enum(['artifact', 'epoch', 'message']),
      id: identifier,
      revision: identifier,
    }),
  ),
  /** Missing one of these fails the handoff before or at delivery. */
  requiredSources: z.array(identifier),
});

const artifactSchema = z.strictObject({
  artifactId: identifier,
  schema: identifier,
  owner: identifier,
  readers: z.array(identifier),
  writers: z.array(identifier),
  revision: count,
  freshnessRule: identifier,
  conflictBehavior: z.enum(['reject-stale', 'last-writer-with-verifier', 'merge-with-verifier']),
  /** Exactly one participant. Never inferred from the most recent message. */
  commitAuthority: identifier,
});

const messageSchemaSchema = z.strictObject({
  schemaId: identifier,
  appliesToIntents: z.array(z.enum(MESSAGE_INTENTS)).min(1),
  definition: identifier,
});

const stageVerifierSchema = z.strictObject({
  stageId: identifier,
  boundAt: z.literal('handoff-creation'),
  acceptanceCriteria: identifier,
  rejector: z.array(identifier).min(1),
  onFailure: z.enum([
    'retry',
    'replan',
    'escalate',
    'quarantine',
    'replace-participant',
    'terminal',
  ]),
  retryBudget: count,
});

const lifecycleSchema = z.strictObject({
  ownership: z.enum(['independently-owned', 'parent-owned']),
  executionMode: z.enum(['synchronous-inline', 'asynchronous']),
  durability: z.enum(['process-local', 'durable']),
  cancellationOwner: identifier,
});

const securitySchema = z.strictObject({
  redactionPolicy: identifier,
  auditRetentionDays: z.number().int().positive(),
  emergencyDisableFlag: identifier,
  messageIntegrityBoundary: z.enum(['required', 'not-required']),
});

export const resourceEnvelopeSchema = z.strictObject({
  tokens: z.number().int().positive(),
  costCents: z.number().min(0),
  wallClockMilliseconds: z.number().int().positive(),
  steps: z.number().int().positive(),
  fanOut: z.number().int().positive(),
  maximumDescendants: count,
  toolAuthority: delegatedAuthoritySchema,
});

export type ResourceEnvelope = z.output<typeof resourceEnvelopeSchema>;

type PlanShape = z.output<typeof planShapeSchema>;

const planShapeSchema = z.strictObject({
  planId: identifier,
  /** Monotonic. A revised plan is a new document, never a mutation of a prior one. */
  planRevision: z.number().int().positive(),
  policyVersion: identifier,
  task: z.strictObject({ taskRevision: identifier, successContractRevision: identifier }),
  taskClass: taskClassSchema,
  executionProfile: z.enum(EXECUTION_PROFILES),
  resourceEnvelope: resourceEnvelopeSchema,
  participants: z.array(participantSchema).min(1),
  topology: z.strictObject({
    defaultForClass: z.boolean(),
    permittedCycles: count,
    maximumRounds: z.number().int().positive(),
    edges: z.array(edgeSchema),
  }),
  contextProjections: z.array(contextProjectionSchema),
  artifacts: z.array(artifactSchema),
  messageSchemas: z.array(messageSchemaSchema),
  stageVerifiers: z.array(stageVerifierSchema),
  /** Plan-wide default; an artifact's own `commitAuthority` overrides it for that artifact. */
  commitAuthority: identifier,
  stopConditions: z.array(identifier).min(1),
  fallback: z.strictObject({ profile: z.literal('direct-agent'), reason: identifier }),
  lifecycle: lifecycleSchema,
  security: securitySchema,
});

/** Adds an issue for each name in `names` that is not a declared participant. */
function reportUnknown(
  participants: ReadonlySet<string>,
  names: readonly string[],
  path: (index: number) => PropertyKey[],
  context: z.RefinementCtx,
): void {
  for (const [index, name] of names.entries()) {
    if (!participants.has(name)) {
      context.addIssue({
        code: 'custom',
        path: path(index),
        message: `Unknown participant "${name}"`,
      });
    }
  }
}

/** The first participant a directed cycle returns to, ignoring self-edges (reported on their own). */
function firstCycle(plan: PlanShape): string | undefined {
  const next = new Map<string, string[]>();
  for (const edge of plan.topology.edges) {
    if (edge.from !== edge.to) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }
  const done = new Set<string>();
  const onPath = new Set<string>();
  function visit(node: string): string | undefined {
    if (onPath.has(node)) return node;
    if (done.has(node)) return undefined;
    onPath.add(node);
    for (const target of next.get(node) ?? []) {
      const cycle = visit(target);
      if (cycle !== undefined) return cycle;
    }
    onPath.delete(node);
    done.add(node);
    return undefined;
  }
  for (const participant of plan.participants) {
    const cycle = visit(participant.agentName);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function reportReferences(plan: PlanShape, context: z.RefinementCtx): void {
  const participants = new Set(plan.participants.map((participant) => participant.agentName));
  const known = (names: readonly string[], path: (index: number) => PropertyKey[]): void =>
    reportUnknown(participants, names, path, context);
  reportDuplicates(
    plan.participants.map((participant) => participant.agentName),
    (index) => ['participants', index, 'agentName'],
    'participant',
    context,
  );
  for (const [index, edge] of plan.topology.edges.entries()) {
    known([edge.from], () => ['topology', 'edges', index, 'from']);
    known([edge.to], () => ['topology', 'edges', index, 'to']);
    if (edge.from === edge.to) {
      context.addIssue({
        code: 'custom',
        path: ['topology', 'edges', index],
        message: 'An edge joins two different participants',
      });
    }
  }
  for (const [index, projection] of plan.contextProjections.entries()) {
    known([projection.participant], () => ['contextProjections', index, 'participant']);
    const named = new Set(projection.sources.map((source) => source.id));
    for (const [position, required] of projection.requiredSources.entries()) {
      if (!named.has(required)) {
        context.addIssue({
          code: 'custom',
          path: ['contextProjections', index, 'requiredSources', position],
          message: `Required source "${required}" is not one of this projection's sources`,
        });
      }
    }
  }
  reportDuplicates(
    plan.contextProjections.map((projection) => projection.participant),
    (index) => ['contextProjections', index, 'participant'],
    'context projection participant',
    context,
  );
  for (const [index, artifact] of plan.artifacts.entries()) {
    known([artifact.owner], () => ['artifacts', index, 'owner']);
    known(artifact.readers, (position) => ['artifacts', index, 'readers', position]);
    known(artifact.writers, (position) => ['artifacts', index, 'writers', position]);
    known([artifact.commitAuthority], () => ['artifacts', index, 'commitAuthority']);
  }
  reportDuplicates(
    plan.artifacts.map((artifact) => artifact.artifactId),
    (index) => ['artifacts', index, 'artifactId'],
    'artifact id',
    context,
  );
  reportDuplicates(
    plan.messageSchemas.map((schema) => schema.schemaId),
    (index) => ['messageSchemas', index, 'schemaId'],
    'message schema id',
    context,
  );
  for (const [index, stage] of plan.stageVerifiers.entries()) {
    known(stage.rejector, (position) => ['stageVerifiers', index, 'rejector', position]);
  }
  reportDuplicates(
    plan.stageVerifiers.map((stage) => stage.stageId),
    (index) => ['stageVerifiers', index, 'stageId'],
    'stage verifier id',
    context,
  );
  known([plan.commitAuthority], () => ['commitAuthority']);
  known([plan.lifecycle.cancellationOwner], () => ['lifecycle', 'cancellationOwner']);
}

function reportClassRules(plan: PlanShape, context: z.RefinementCtx): void {
  const { taskClass, topology } = plan;
  const cyclesAllowed = isExtensionTaskClass(taskClass) || taskClass === 'verifier-revision';
  if (!cyclesAllowed && topology.permittedCycles > 0) {
    context.addIssue({
      code: 'custom',
      path: ['topology', 'permittedCycles'],
      message: `Only a verifier-revision or extension plan may permit cycles; a ${taskClass} plan permits 0`,
    });
  }
  const cycle = firstCycle(plan);
  if (cycle !== undefined && topology.permittedCycles === 0) {
    context.addIssue({
      code: 'custom',
      path: ['topology', 'edges'],
      message: `The edges form a cycle through "${cycle}", but the plan permits no cycles`,
    });
  }
  if (taskClass === 'verifier-revision' && plan.executionProfile === 'collaboration') {
    if (topology.permittedCycles === 0) {
      context.addIssue({
        code: 'custom',
        path: ['topology', 'permittedCycles'],
        message:
          'A verifier-revision plan needs a bounded producer-verifier cycle; permit at least one',
      });
    }
    if (plan.stageVerifiers.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['stageVerifiers'],
        message: 'A verifier-revision plan needs a stage verifier bound at handoff creation',
      });
    }
  }
  if (isExtensionTaskClass(taskClass) && topology.defaultForClass) {
    context.addIssue({
      code: 'custom',
      path: ['topology', 'defaultForClass'],
      message:
        'An extension class has no default topology; author it and set defaultForClass to false',
    });
  }
  if (plan.executionProfile === 'direct-agent') {
    if (plan.participants.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['participants'],
        message: 'A direct-agent plan has exactly one participant',
      });
    }
    if (topology.edges.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['topology', 'edges'],
        message: 'A direct-agent plan has no edges',
      });
    }
  }
  if (
    taskClass === 'shared-state' &&
    plan.executionProfile === 'collaboration' &&
    plan.artifacts.length === 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['artifacts'],
      message: 'A shared-state collaboration declares its authoritative state as an artifact',
    });
  }
}

export const collaborationPlanSchema = planShapeSchema.superRefine((plan, context) => {
  reportReferences(plan, context);
  reportClassRules(plan, context);
});

export type CollaborationPlan = z.output<typeof collaborationPlanSchema>;
export type CollaborationParticipant = CollaborationPlan['participants'][number];
export type CollaborationArtifact = CollaborationPlan['artifacts'][number];

/** Parses a plan, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseCollaborationPlan(input: unknown): CollaborationPlan {
  const parsed = collaborationPlanSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

/** The SHA-256 of the plan's canonical JSON: any field change moves it, key order never does. */
export function collaborationPlanDigest(plan: CollaborationPlan): Promise<string> {
  return sha256Hex(canonicalJson(plan));
}

/**
 * One message between participants (COR-820, "Message intent and epistemic
 * authority"). Every inbound message starts as an untrusted claim until a
 * verifier or policy promotes it, and a verification result or commit
 * carries the digest of the evidence it rests on.
 */
export const collaborationMessageSchema = z
  .strictObject({
    intent: z.enum(MESSAGE_INTENTS),
    sender: identifier,
    recipient: identifier,
    relationship: z.enum(['peer', 'parent-child', 'verifier-producer', 'commit-authority']),
    source: identifier,
    trustClass: z.enum(['trusted-authored', 'untrusted-claim']),
    /** References `CollaborationPlan.messageSchemas[].schemaId`. */
    schema: identifier,
    subject: identifier,
    provenance: identifier,
    correlation: identifier,
    evidenceDigest: identifier.optional(),
  })
  .superRefine((message, context) => {
    const needsEvidence = message.intent === 'verification-result' || message.intent === 'commit';
    if (needsEvidence && message.evidenceDigest === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceDigest'],
        message: `A ${message.intent} message carries the evidence digest it rests on`,
      });
    }
  });

export type CollaborationMessage = z.output<typeof collaborationMessageSchema>;
