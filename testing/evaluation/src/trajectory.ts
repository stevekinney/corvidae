/**
 * Coordination metrics and failure labels from a run's trajectory (COR-818).
 * A trajectory is the ordered list of observable events one run of one
 * execution profile produced: participants starting, finishing, or being
 * detached; handoffs and the sources they delivered; messages in COR-820's
 * envelope; reads and writes of declared artifacts; units of work;
 * retries, replans, injected faults, and quarantines.
 *
 * {@link measureTrajectory} reads it against the run's `CollaborationPlan`
 * and reports three things, none of which ever counts message volume,
 * agreement, or self-reported confidence as success:
 *
 * - coordination metrics: coordination tokens and turns (messages only),
 *   writes to undeclared stores (never coordination), duplicate work,
 *   message novelty, corrected false claims, unresolved contradictions,
 *   stale reads, retries, replans, and propagated faults;
 * - failure labels, each tied to the event that showed it: what the plan
 *   makes structurally checkable is derived here, and what only a reviewer
 *   or verifier can judge arrives as a `failure-observed` event;
 * - cleanup: whether every participant finished (quiescent), some were
 *   deliberately detached as named work items (detached), or some were
 *   silently abandoned: still running at the end, or acting where no
 *   recorded start covered them.
 *
 * Epistemic authority follows COR-820: a verdict counts only from a
 * participant with the verifier role or a stage-verifier binding, a commit
 * only from the artifact's (or the plan's) commit authority, and a message
 * is trusted only once a verifier has accepted its correlation. A write to
 * an artifact the plan does not declare is ungoverned: it is reported, but
 * it is never coordination and never a commit.
 */
import { z } from 'zod';

import {
  type CollaborationMessage,
  collaborationMessageSchema,
  type CollaborationPlan,
} from './collaboration-plan';
import { EvaluatorConfigurationError, identifier, toConfigurationIssues } from './configuration';

/** Every failure label a trajectory measurement can report, derived or reviewer-observed. */
export const FAILURE_LABELS = [
  'task-role-drift',
  'cycle',
  'history-loss',
  'reset',
  'ignored-or-withheld-information',
  'action-reasoning-mismatch',
  'premature-completion',
  'missing-or-incorrect-verification',
  'incompatible-conventions',
  'conflicting-commits',
  'untrusted-message-elevation',
  'prompt-infection',
  'faulty-agent-contamination',
] as const;

export type FailureLabel = (typeof FAILURE_LABELS)[number];

const count = z.number().int().min(0);
const participant = identifier;

const trajectoryEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('participant-started'), participant }),
  z.strictObject({
    type: z.literal('participant-finished'),
    participant,
    outcome: z.enum(['completed', 'failed', 'cancelled']),
  }),
  z.strictObject({
    type: z.literal('participant-detached'),
    participant,
    /** The named work item that outlives the run. */
    workItem: identifier,
    reason: identifier,
  }),
  z.strictObject({ type: z.literal('handoff'), participant, sources: z.array(identifier) }),
  z.strictObject({
    type: z.literal('message'),
    message: collaborationMessageSchema,
    tokens: count,
    /** A digest of the payload, so repetition is visible without keeping the payload. */
    contentDigest: identifier,
    /** Exactly on a verification result. */
    verdict: z.enum(['accepted', 'rejected']).optional(),
  }),
  z.strictObject({
    type: z.literal('artifact-read'),
    participant,
    artifactId: identifier,
    revision: count,
  }),
  z.strictObject({
    type: z.literal('artifact-write'),
    participant,
    artifactId: identifier,
    baseRevision: count,
    intent: z.enum(['proposal', 'commit']),
  }),
  z.strictObject({ type: z.literal('work'), participant, unit: identifier }),
  z.strictObject({ type: z.literal('retry'), participant, stageId: identifier }),
  z.strictObject({ type: z.literal('replan'), participant, reason: identifier }),
  z.strictObject({
    type: z.literal('fault'),
    participant,
    kind: z.enum(['faulty-output', 'prompt-injection']),
    payloadDigest: identifier,
  }),
  z.strictObject({ type: z.literal('quarantine'), participant }),
  z.strictObject({
    type: z.literal('failure-observed'),
    label: z.enum(FAILURE_LABELS),
    participant,
    evidence: identifier,
  }),
]);

/** One run's ordered trajectory events, as a collaboration subject reports them. */
export const collaborationTrajectorySchema = z
  .array(trajectoryEventSchema)
  .superRefine((events, context) => {
    for (const [index, event] of events.entries()) {
      if (event.type !== 'message') continue;
      const isVerification = event.message.intent === 'verification-result';
      if (isVerification && event.verdict === undefined) {
        context.addIssue({
          code: 'custom',
          path: [index, 'verdict'],
          message: 'A verification result carries an accepted or rejected verdict',
        });
      }
      if (!isVerification && event.verdict !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [index, 'verdict'],
          message: 'Only a verification result carries a verdict',
        });
      }
    }
  });

export type TrajectoryEvent = z.output<typeof trajectoryEventSchema>;
export type CollaborationTrajectory = z.output<typeof collaborationTrajectorySchema>;

/** Parses a trajectory, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseCollaborationTrajectory(input: unknown): CollaborationTrajectory {
  const parsed = collaborationTrajectorySchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

export const coordinationMetricsSchema = z.strictObject({
  /** Messages between participants. */
  coordinationTurns: count,
  /** Tokens those messages spent. */
  coordinationTokens: count,
  /** Writes to a store the plan does not declare: reported, never coordination or a commit. */
  ungovernedWrites: count,
  /** Units of work already done by an earlier work event. */
  duplicateWork: count,
  /** The share of messages whose content no earlier message carried; `null` without messages. */
  messageNovelty: z.number().min(0).max(1).nullable(),
  /** Subjects a verifier rejected and later accepted a revised claim about. */
  correctedFalseClaims: count,
  /** Subjects with conflicting claims that no accepted verification settled. */
  unresolvedContradictions: count,
  /** Reads of an artifact revision a commit had already superseded. */
  staleReads: count,
  retries: count,
  replans: count,
  /** Messages and proposals a faulty participant sent before it was quarantined. */
  propagatedFaults: count,
});

export type CoordinationMetrics = z.output<typeof coordinationMetricsSchema>;

export const failureOccurrenceSchema = z.strictObject({
  label: z.enum(FAILURE_LABELS),
  /** `null` only for a failure the comparison found across the run, not at one participant. */
  participant: identifier.nullable(),
  /** The trajectory event that showed it; `null` for a comparison-level finding. */
  event: count.nullable(),
  evidence: identifier,
});

export type FailureOccurrence = z.output<typeof failureOccurrenceSchema>;

/** How a run ended for its participants: all finished, some detached as named work, or some abandoned. */
export const CLEANUP_STATES = ['quiescent', 'detached', 'abandoned'] as const;

export type CleanupState = (typeof CLEANUP_STATES)[number];

export const cleanupReportSchema = z.strictObject({
  state: z.enum(CLEANUP_STATES),
  detached: z.array(z.strictObject({ participant, workItem: identifier, reason: identifier })),
  /**
   * Participants no recorded lifetime accounts for: still running at the end,
   * or acting before any start or after they finished or detached.
   */
  abandoned: z.array(identifier),
});

export type CleanupReport = z.output<typeof cleanupReportSchema>;

export interface TrajectoryMeasurement {
  readonly coordination: CoordinationMetrics;
  readonly failures: readonly FailureOccurrence[];
  readonly cleanup: CleanupReport;
  readonly participants: { readonly started: number; readonly maximumConcurrent: number };
  /** The last verdict an authorized verifier gave in the run; `null` when none did. */
  readonly lastVerdict: 'accepted' | 'rejected' | null;
}

/**
 * The intents that carry work: an observation, hypothesis, proposal, or
 * artifact. A request, verification result, commit, rejection, or
 * cancellation is not work. Work a participant sends a verifier on a subject
 * is what that verifier's rejection rejects, and the first work sent after
 * such a rejection is a revision (see {@link countRevision}).
 */
const CLAIM_INTENTS = new Set<string>(['observation', 'hypothesis', 'proposal', 'artifact']);

/**
 * The events that show their `participant` acting. A message shows its
 * sender acting; lifecycle events, a quarantine, and a reviewer's observation
 * show no one.
 */
const ACTING_EVENTS = new Set<TrajectoryEvent['type']>([
  'handoff',
  'work',
  'artifact-read',
  'artifact-write',
  'retry',
  'replan',
  'fault',
]);

/** `acting` is running without a recorded start: before it, or after a finish or detachment. */
type Lifecycle = 'running' | 'acting' | 'finished' | 'detached';

/** One (participant, verifier, subject) revision count. */
interface RevisionCount {
  /** Whether the participant has sent the verifier work on the subject. */
  sent: boolean;
  /** Whether a rejection has opened a revision the participant has not yet sent. */
  open: boolean;
  /** How many revisions the participant has sent. */
  count: number;
}

/** Everything one pass over a trajectory keeps track of. */
class TrajectoryState {
  readonly failures: FailureOccurrence[] = [];
  readonly participants: ReadonlySet<string>;
  readonly verifiers: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  readonly schemas: ReadonlyMap<string, readonly string[]>;
  readonly requiredSources: ReadonlyMap<string, readonly string[]>;
  readonly artifacts: ReadonlyMap<string, CollaborationPlan['artifacts'][number]>;
  readonly revisions = new Map<string, number>();
  readonly lifecycle = new Map<string, Lifecycle>();
  /** Participants that acted while no recorded start covered them. */
  readonly unaccounted = new Set<string>();
  readonly detached: CleanupReport['detached'][number][] = [];
  readonly delivered = new Map<string, Set<string>>();
  readonly units = new Set<string>();
  readonly digests = new Set<string>();
  /** Per (participant, verifier, subject), the revisions it has sent. */
  readonly revisionCounts = new Map<string, RevisionCount>();
  readonly claims = new Map<string, Set<string>>();
  readonly contradicted = new Set<string>();
  readonly refuted = new Set<string>();
  readonly acceptedSubjects = new Set<string>();
  readonly acceptedCorrelations = new Set<string>();
  readonly faulted = new Set<string>();
  readonly injected = new Map<string, string>();
  readonly tainted = new Set<string>();
  running = 0;
  maximumConcurrent = 0;
  turns = 0;
  tokens = 0;
  novel = 0;
  ungovernedWrites = 0;
  duplicateWork = 0;
  corrected = 0;
  staleReads = 0;
  retries = 0;
  replans = 0;
  propagatedFaults = 0;
  lastVerdict: 'accepted' | 'rejected' | null = null;

  constructor(readonly plan: CollaborationPlan) {
    this.participants = new Set(plan.participants.map((entry) => entry.agentName));
    this.verifiers = new Set([
      ...plan.participants
        .filter((entry) => entry.role === 'verifier')
        .map((entry) => entry.agentName),
      ...plan.stageVerifiers.flatMap((stage) => stage.rejector),
    ]);
    this.edges = new Set(plan.topology.edges.map((edge) => edgeKey(edge.from, edge.to)));
    this.schemas = new Map(
      plan.messageSchemas.map((schema) => [schema.schemaId, schema.appliesToIntents]),
    );
    this.requiredSources = new Map(
      plan.contextProjections.map((projection) => [
        projection.participant,
        projection.requiredSources,
      ]),
    );
    this.artifacts = new Map(plan.artifacts.map((artifact) => [artifact.artifactId, artifact]));
    for (const artifact of plan.artifacts)
      this.revisions.set(artifact.artifactId, artifact.revision);
  }

  fail(label: FailureLabel, who: string, event: number, evidence: string): void {
    this.failures.push({ label, participant: who, event, evidence });
  }
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function isRunning(lifecycle: Lifecycle | undefined): boolean {
  return lifecycle === 'running' || lifecycle === 'acting';
}

/** Counts `who` as running from now on, as `lifecycle`. */
function run(state: TrajectoryState, who: string, lifecycle: Lifecycle): void {
  state.lifecycle.set(who, lifecycle);
  state.running += 1;
  state.maximumConcurrent = Math.max(state.maximumConcurrent, state.running);
}

function onStarted(state: TrajectoryState, who: string, index: number): void {
  const lifecycle = state.lifecycle.get(who);
  if (lifecycle === 'running') {
    state.fail('reset', who, index, 'Started again before its earlier start finished');
  } else if (lifecycle === 'acting') {
    // Already running, and already counted: this is the start its activity preceded.
    state.lifecycle.set(who, 'running');
  } else {
    run(state, who, 'running');
  }
}

function onStopped(state: TrajectoryState, who: string, next: Lifecycle): void {
  if (isRunning(state.lifecycle.get(who))) state.running -= 1;
  state.lifecycle.set(who, next);
}

/**
 * Records that `who` acted. A participant acting while it is not running
 * (before any start, or after it finished or detached) ran where no
 * recorded lifetime accounts for it. It counts as running from here, toward
 * descendants and fan-out, and cleanup names it as abandoned whatever its
 * lifecycle does next.
 */
function onActed(state: TrajectoryState, who: string): void {
  if (isRunning(state.lifecycle.get(who))) return;
  state.unaccounted.add(who);
  run(state, who, 'acting');
}

function onHandoff(
  state: TrajectoryState,
  who: string,
  sources: readonly string[],
  index: number,
): void {
  const delivered = new Set(sources);
  const withheld = (state.requiredSources.get(who) ?? []).filter(
    (source) => !delivered.has(source),
  );
  if (withheld.length > 0) {
    state.fail(
      'ignored-or-withheld-information',
      who,
      index,
      `The handoff withheld required sources: ${withheld.join(', ')}`,
    );
  }
  const earlier = state.delivered.get(who) ?? new Set<string>();
  const dropped = [...earlier].filter((source) => !delivered.has(source));
  if (dropped.length > 0) {
    state.fail(
      'history-loss',
      who,
      index,
      `A later handoff dropped sources it had already delivered: ${dropped.join(', ')}`,
    );
  }
  state.delivered.set(who, new Set([...earlier, ...sources]));
}

/** The participant whose commit a subject needs: its artifact's authority, else the plan's. */
function commitAuthorityOf(state: TrajectoryState, subject: string): string {
  return state.artifacts.get(subject)?.commitAuthority ?? state.plan.commitAuthority;
}

/**
 * Checks one commit of `subject` by `who`, and reports whether it came from
 * the commit authority (only then does it count as a commit at all).
 */
function checkCommit(state: TrajectoryState, who: string, subject: string, index: number): boolean {
  const authority = commitAuthorityOf(state, subject);
  if (who !== authority) {
    state.fail(
      'premature-completion',
      who,
      index,
      `Committed "${subject}", whose commit authority is ${authority}`,
    );
    return false;
  }
  if (state.plan.stageVerifiers.length > 0 && !state.acceptedSubjects.has(subject)) {
    state.fail(
      'missing-or-incorrect-verification',
      who,
      index,
      `Committed "${subject}" before any verifier accepted it`,
    );
  }
  if (state.tainted.has(subject)) {
    state.fail(
      'faulty-agent-contamination',
      who,
      index,
      `Committed "${subject}", which a faulty participant had touched`,
    );
  }
  return true;
}

function checkConventions(
  state: TrajectoryState,
  message: CollaborationMessage,
  index: number,
): void {
  const intents = state.schemas.get(message.schema);
  if (intents === undefined) {
    state.fail(
      'incompatible-conventions',
      message.sender,
      index,
      `Used message schema "${message.schema}", which the plan does not declare`,
    );
  } else if (!intents.includes(message.intent)) {
    state.fail(
      'incompatible-conventions',
      message.sender,
      index,
      `Sent a ${message.intent} message under schema "${message.schema}", which does not cover that intent`,
    );
  }
}

/** The revision count of `producer`'s work to `verifier` on `subject`, begun on first use. */
function revisionCountOf(
  state: TrajectoryState,
  producer: string,
  verifier: string,
  subject: string,
): RevisionCount {
  const key = `${producer}\u0000${verifier}\u0000${subject}`;
  const counted = state.revisionCounts.get(key) ?? { sent: false, open: false, count: 0 };
  state.revisionCounts.set(key, counted);
  return counted;
}

/**
 * Counts revisions, per (participant P, verifier V, subject s), as COR-820's
 * amendment of 2026-09-29 defines a cycle. A rejection is a
 * `verification-result` with a `rejected` verdict from V (a participant with
 * the verifier role or a stage-verifier binding) to P on s. It rejects P's
 * latest work to V on s, chosen by order alone (`correlation` is not read),
 * and opens a revision if there is any; if P has sent V no work on s, it
 * rejects and opens nothing. The first work P then sends V on s is the
 * revision, and sending it closes it. So a rejection opens at most one: more
 * work before V's next rejection is not a revision, and two rejections before
 * P's next work open one. An acceptance, request, commit, cancellation, or
 * work P sends anyone else leaves an open revision open.
 *
 * `permittedCycles: N` allows N revisions per (P, V, s), never summed across
 * keys; each revision whose count k exceeds N is labelled `cycle`. Every
 * message from a declared participant to a declared participant is counted,
 * whether or not its edge is declared.
 *
 * Each count depends only on the order of P's work to V on s and V's
 * rejections of it, so interleaving other participants or subjects never
 * changes it; the work per event is constant and no plan graph is read.
 *
 * Known limits, deliberate: a revision relayed through another participant,
 * forwarded, or sent to a verifier other than the one that rejected is not
 * counted, and a rejection that follows relayed work is attributed to P's
 * latest direct work to V on s; a verifier that answers with observations or
 * `rejection` messages drives no revisions; and work sent with no rejection
 * before it is not a revision.
 */
function countRevision(state: TrajectoryState, message: CollaborationMessage, index: number): void {
  if (!CLAIM_INTENTS.has(message.intent)) return;
  const { sender, recipient, subject } = message;
  const counted = revisionCountOf(state, sender, recipient, subject);
  counted.sent = true;
  if (!counted.open) return;
  counted.open = false;
  counted.count += 1;
  const permitted = state.plan.topology.permittedCycles;
  if (counted.count > permitted) {
    state.fail(
      'cycle',
      sender,
      index,
      `Cycle ${counted.count} exceeds the plan's limit of ${permitted}`,
    );
  }
}

/** A verifier's rejection opens a revision of the work it rejects, if it rejects any. */
function openRevision(state: TrajectoryState, message: CollaborationMessage): void {
  const counted = revisionCountOf(state, message.recipient, message.sender, message.subject);
  if (counted.sent) counted.open = true;
}

function checkRoute(state: TrajectoryState, message: CollaborationMessage, index: number): void {
  const { sender, recipient } = message;
  if (!state.edges.has(edgeKey(sender, recipient))) {
    state.fail(
      'task-role-drift',
      sender,
      index,
      `Sent a message along the undeclared edge ${sender} -> ${recipient}`,
    );
  }
}

function onVerdict(
  state: TrajectoryState,
  message: CollaborationMessage,
  verdict: 'accepted' | 'rejected' | undefined,
  index: number,
): void {
  if (!state.verifiers.has(message.sender)) {
    state.fail(
      'task-role-drift',
      message.sender,
      index,
      'Sent a verification result without a verifier role or stage',
    );
    return;
  }
  const { subject } = message;
  // Only an explicit acceptance promotes anything; the schema requires a verdict here.
  const accepted = verdict === 'accepted';
  state.lastVerdict = accepted ? 'accepted' : 'rejected';
  if (!accepted) {
    state.refuted.add(subject);
    openRevision(state, message);
    return;
  }
  state.acceptedSubjects.add(subject);
  state.acceptedCorrelations.add(message.correlation);
  state.contradicted.delete(subject);
  if (state.refuted.delete(subject)) state.corrected += 1;
}

function onClaim(state: TrajectoryState, message: CollaborationMessage, digest: string): void {
  const claims = state.claims.get(message.subject) ?? new Set<string>();
  claims.add(digest);
  state.claims.set(message.subject, claims);
  if (claims.size > 1) state.contradicted.add(message.subject);
}

function onMessage(
  state: TrajectoryState,
  event: Extract<TrajectoryEvent, { type: 'message' }>,
  index: number,
): void {
  const { message, contentDigest } = event;
  const { sender, recipient } = message;
  state.turns += 1;
  state.tokens += event.tokens;
  if (!state.digests.has(contentDigest)) state.novel += 1;
  state.digests.add(contentDigest);
  if (!state.participants.has(sender) || !state.participants.has(recipient)) {
    state.fail(
      'task-role-drift',
      sender,
      index,
      `A message names a participant the plan does not declare: ${sender} -> ${recipient}`,
    );
    return;
  }
  checkConventions(state, message, index);
  checkRoute(state, message, index);
  countRevision(state, message, index);
  if (
    message.trustClass === 'trusted-authored' &&
    !state.acceptedCorrelations.has(message.correlation)
  ) {
    state.fail(
      'untrusted-message-elevation',
      sender,
      index,
      `Delivered as trusted without an accepted verification of ${message.correlation}`,
    );
  }
  const origin = state.injected.get(contentDigest);
  if (origin !== undefined && origin !== sender) {
    state.fail('prompt-infection', sender, index, `Repeated a payload injected into ${origin}`);
  }
  if (state.faulted.has(sender)) {
    state.propagatedFaults += 1;
    state.tainted.add(message.subject);
  }
  if (message.intent === 'verification-result') onVerdict(state, message, event.verdict, index);
  else if (message.intent === 'rejection') state.refuted.add(message.subject);
  else if (message.intent === 'commit') checkCommit(state, sender, message.subject, index);
  else if (CLAIM_INTENTS.has(message.intent)) onClaim(state, message, contentDigest);
}

function onRead(state: TrajectoryState, artifactId: string, revision: number): void {
  const current = state.revisions.get(artifactId);
  if (current !== undefined && revision < current) state.staleReads += 1;
}

function onWrite(
  state: TrajectoryState,
  event: Extract<TrajectoryEvent, { type: 'artifact-write' }>,
  index: number,
): void {
  const { participant: who, artifactId } = event;
  const artifact = state.artifacts.get(artifactId);
  if (artifact === undefined) {
    state.ungovernedWrites += 1;
    return;
  }
  if (event.intent === 'proposal') {
    if (!artifact.writers.includes(who)) {
      state.fail(
        'task-role-drift',
        who,
        index,
        `Proposed a write to "${artifactId}" without being one of its writers`,
      );
    }
    if (state.faulted.has(who)) {
      state.propagatedFaults += 1;
      state.tainted.add(artifactId);
    }
    return;
  }
  if (!checkCommit(state, who, artifactId, index)) return;
  const current = state.revisions.get(artifactId) as number;
  if (event.baseRevision !== current) {
    state.fail(
      'conflicting-commits',
      who,
      index,
      `Committed "${artifactId}" against revision ${event.baseRevision}, but it is at revision ${current}`,
    );
    if (artifact.conflictBehavior === 'reject-stale') return;
  }
  state.revisions.set(artifactId, current + 1);
}

function visit(state: TrajectoryState, event: TrajectoryEvent, index: number): void {
  if (event.type === 'message') onActed(state, event.message.sender);
  else if (ACTING_EVENTS.has(event.type)) onActed(state, event.participant);
  switch (event.type) {
    case 'participant-started':
      return onStarted(state, event.participant, index);
    case 'participant-finished':
      return onStopped(state, event.participant, 'finished');
    case 'participant-detached':
      onStopped(state, event.participant, 'detached');
      state.detached.push({
        participant: event.participant,
        workItem: event.workItem,
        reason: event.reason,
      });
      return;
    case 'handoff':
      return onHandoff(state, event.participant, event.sources, index);
    case 'message':
      return onMessage(state, event, index);
    case 'artifact-read':
      return onRead(state, event.artifactId, event.revision);
    case 'artifact-write':
      return onWrite(state, event, index);
    case 'work':
      if (state.units.has(event.unit)) state.duplicateWork += 1;
      state.units.add(event.unit);
      return;
    case 'retry':
      state.retries += 1;
      return;
    case 'replan':
      state.replans += 1;
      return;
    case 'fault':
      state.faulted.add(event.participant);
      if (event.kind === 'prompt-injection')
        state.injected.set(event.payloadDigest, event.participant);
      return;
    case 'quarantine':
      state.faulted.delete(event.participant);
      return;
    case 'failure-observed':
      return state.fail(event.label, event.participant, index, event.evidence);
  }
}

/** Coordination metrics, failure labels, and cleanup state for one run's trajectory under `plan`. */
export function measureTrajectory(
  plan: CollaborationPlan,
  trajectory: readonly TrajectoryEvent[],
): TrajectoryMeasurement {
  const state = new TrajectoryState(plan);
  for (const [index, event] of trajectory.entries()) visit(state, event, index);

  const abandoned = [...state.lifecycle]
    .filter(([name, lifecycle]) => isRunning(lifecycle) || state.unaccounted.has(name))
    .map(([name]) => name);
  let cleanupState: CleanupState = 'quiescent';
  if (abandoned.length > 0) cleanupState = 'abandoned';
  else if (state.detached.length > 0) cleanupState = 'detached';
  return {
    coordination: {
      coordinationTurns: state.turns,
      coordinationTokens: state.tokens,
      ungovernedWrites: state.ungovernedWrites,
      duplicateWork: state.duplicateWork,
      messageNovelty: state.turns === 0 ? null : state.novel / state.turns,
      correctedFalseClaims: state.corrected,
      unresolvedContradictions: state.contradicted.size,
      staleReads: state.staleReads,
      retries: state.retries,
      replans: state.replans,
      propagatedFaults: state.propagatedFaults,
    },
    failures: state.failures,
    cleanup: { state: cleanupState, detached: state.detached, abandoned },
    participants: { started: state.lifecycle.size, maximumConcurrent: state.maximumConcurrent },
    lastVerdict: state.lastVerdict,
  };
}
