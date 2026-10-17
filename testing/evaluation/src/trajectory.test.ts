import { describe, expect, test } from 'bun:test';

import { type CollaborationPlan, parseCollaborationPlan } from './collaboration-plan';
import {
  type EdgeInput,
  fullyConnectedPlanInput,
  type ParticipantInput,
  partitionedSearchPlanInput,
  type PlanInput,
  planInput,
  sharedStatePlanInput,
  verifierRevisionPlanInput,
} from './fixtures/comparison/plans';
import {
  collaborationTrajectorySchema,
  FAILURE_LABELS,
  type FailureLabel,
  type FailureOccurrence,
  measureTrajectory,
  parseCollaborationTrajectory,
  type TrajectoryEvent,
} from './trajectory';

const partitioned = parseCollaborationPlan(partitionedSearchPlanInput());
const sharedState = parseCollaborationPlan(sharedStatePlanInput());
const revision = parseCollaborationPlan(verifierRevisionPlanInput());

interface MessageOptions {
  readonly intent?: string;
  readonly from?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly digest?: string;
  readonly tokens?: number;
  readonly schema?: string;
  readonly trust?: 'trusted-authored' | 'untrusted-claim';
  readonly correlation?: string;
  readonly verdict?: 'accepted' | 'rejected';
}

/** The intents the fixture plans' `verdict-1` schema covers; `finding-1` covers the rest. */
const VERDICT_SCHEMA_INTENTS = new Set([
  'verification-result',
  'rejection',
  'commit',
  'cancellation',
]);

function message(options: MessageOptions = {}): TrajectoryEvent {
  const intent = options.intent ?? 'observation';
  const needsEvidence = intent === 'verification-result' || intent === 'commit';
  const needsVerdict = intent === 'verification-result';
  return {
    type: 'message',
    message: {
      intent,
      sender: options.from ?? 'searcher-a',
      recipient: options.to ?? 'reducer',
      relationship: 'peer',
      source: 'shard',
      trustClass: options.trust ?? 'untrusted-claim',
      schema: options.schema ?? (VERDICT_SCHEMA_INTENTS.has(intent) ? 'verdict-1' : 'finding-1'),
      subject: options.subject ?? 'answer',
      provenance: 'epoch-1',
      correlation: options.correlation ?? 'handoff-1',
      ...(needsEvidence ? { evidenceDigest: 'sha256:evidence' } : {}),
    },
    tokens: options.tokens ?? 10,
    contentDigest:
      options.digest ?? `${options.from ?? 'searcher-a'}:${options.subject ?? 'answer'}`,
    ...(needsVerdict ? { verdict: options.verdict ?? 'accepted' } : {}),
  } as TrajectoryEvent;
}

function started(...participants: string[]): TrajectoryEvent[] {
  return participants.map((participant) => ({ type: 'participant-started', participant }));
}

function finished(...participants: string[]): TrajectoryEvent[] {
  return participants.map((participant) => ({
    type: 'participant-finished',
    participant,
    outcome: 'completed',
  }));
}

const SEARCHERS = ['searcher-a', 'searcher-b', 'searcher-c'];

function handoffs(): TrajectoryEvent[] {
  return SEARCHERS.map((participant, index) => ({
    type: 'handoff',
    participant,
    sources: [`shard-${'abc'[index]}`],
  }));
}

/** A clean partitioned search: three shard reports, one commit, everyone finished. */
function cleanSearch(): TrajectoryEvent[] {
  return [
    ...started(...SEARCHERS, 'reducer'),
    ...handoffs(),
    ...SEARCHERS.map((participant, index): TrajectoryEvent => ({
      type: 'work',
      participant,
      unit: `shard-${'abc'[index]}`,
    })),
    ...SEARCHERS.map((from, index) =>
      message({ from, subject: `digit-${index}`, digest: `digit-${index}`, tokens: 5 + index }),
    ),
    {
      type: 'artifact-write',
      participant: 'reducer',
      artifactId: 'answer',
      baseRevision: 0,
      intent: 'commit',
    },
    ...finished(...SEARCHERS, 'reducer'),
  ];
}

function labels(plan: CollaborationPlan, events: readonly TrajectoryEvent[]): FailureLabel[] {
  return measureTrajectory(plan, events).failures.map((failure) => failure.label);
}

describe('measureTrajectory', () => {
  test('reports coordination metrics, quiescence, and no failure for a clean partitioned search', () => {
    const measurement = measureTrajectory(partitioned, cleanSearch());
    expect(measurement.coordination).toEqual({
      coordinationTurns: 3,
      coordinationTokens: 18,
      ungovernedWrites: 0,
      duplicateWork: 0,
      messageNovelty: 1,
      correctedFalseClaims: 0,
      unresolvedContradictions: 0,
      staleReads: 0,
      retries: 0,
      replans: 0,
      propagatedFaults: 0,
    });
    expect(measurement.failures).toEqual([]);
    expect(measurement.cleanup).toEqual({ state: 'quiescent', detached: [], abandoned: [] });
    expect(measurement.participants).toEqual({ started: 4, maximumConcurrent: 4 });
    expect(measurement.lastVerdict).toBeNull();
  });

  test('counts duplicate work units and repeated message content', () => {
    const events: TrajectoryEvent[] = [
      ...started('searcher-a', 'searcher-b'),
      { type: 'work', participant: 'searcher-a', unit: 'shard-a' },
      { type: 'work', participant: 'searcher-b', unit: 'shard-a' },
      { type: 'work', participant: 'searcher-b', unit: 'shard-b' },
      message({ from: 'searcher-a', digest: 'same' }),
      message({ from: 'searcher-b', digest: 'same' }),
      message({ from: 'searcher-b', digest: 'new' }),
      message({ from: 'searcher-b', digest: 'same' }),
      ...finished('searcher-a', 'searcher-b'),
    ];
    const { coordination } = measureTrajectory(partitioned, events);
    expect(coordination.duplicateWork).toBe(1);
    expect(coordination.messageNovelty).toBe(0.5);
    expect(coordination.coordinationTurns).toBe(4);
  });

  test('has no message novelty without messages, rather than inventing one', () => {
    expect(measureTrajectory(partitioned, []).coordination.messageNovelty).toBeNull();
  });

  test('counts a claim the verifier rejected and later accepted as corrected', () => {
    const events: TrajectoryEvent[] = [
      message({
        intent: 'hypothesis',
        from: 'writer',
        to: 'counter',
        subject: 'sentence',
        digest: 'six-words',
      }),
      message({
        intent: 'verification-result',
        from: 'counter',
        to: 'writer',
        subject: 'sentence',
        verdict: 'rejected',
        digest: 'too-short',
      }),
      message({
        intent: 'hypothesis',
        from: 'writer',
        to: 'counter',
        subject: 'sentence',
        digest: 'seven-words',
      }),
      message({
        intent: 'verification-result',
        from: 'counter',
        to: 'writer',
        subject: 'sentence',
        verdict: 'accepted',
        digest: 'ok',
      }),
      message({
        intent: 'hypothesis',
        from: 'writer',
        to: 'counter',
        subject: 'title',
        digest: 'title-1',
      }),
      message({
        intent: 'rejection',
        from: 'counter',
        to: 'writer',
        subject: 'title',
        digest: 'no-title',
      }),
    ];
    const { coordination, lastVerdict } = measureTrajectory(revision, events);
    expect(coordination.correctedFalseClaims).toBe(1);
    // The last verdict an authorized verifier gave, which the comparison holds against task success.
    expect(lastVerdict).toBe('accepted');
    expect(measureTrajectory(revision, events.slice(0, 2)).lastVerdict).toBe('rejected');
    // The sentence contradiction was settled by the accepted verification; nothing else conflicts.
    expect(coordination.unresolvedContradictions).toBe(0);
  });

  test('counts conflicting claims about one subject until a verifier accepts one', () => {
    const claim = (subject: string, digest: string) =>
      message({ from: 'writer', to: 'counter', subject, digest });
    const conflicting = [claim('digit', 'four'), claim('digit', 'nine'), claim('other', 'two')];
    expect(measureTrajectory(revision, conflicting).coordination.unresolvedContradictions).toBe(1);

    const verdict = message({
      intent: 'verification-result',
      from: 'counter',
      to: 'writer',
      subject: 'digit',
    });
    const settled = [...conflicting, verdict];
    expect(measureTrajectory(revision, settled).coordination.unresolvedContradictions).toBe(0);
    // A verdict from a participant with no verifier role or stage settles nothing.
    const unauthorized = message({
      intent: 'verification-result',
      from: 'writer',
      to: 'counter',
      subject: 'digit',
    });
    expect(
      measureTrajectory(revision, [...conflicting, unauthorized]).coordination
        .unresolvedContradictions,
    ).toBe(1);
  });

  test('counts a read of an artifact revision a commit has already superseded as stale', () => {
    const events: TrajectoryEvent[] = [
      {
        type: 'artifact-read',
        participant: 'clerk-one',
        artifactId: 'inventory-count',
        revision: 0,
      },
      {
        type: 'artifact-write',
        participant: 'keeper',
        artifactId: 'inventory-count',
        baseRevision: 0,
        intent: 'commit',
      },
      {
        type: 'artifact-read',
        participant: 'clerk-two',
        artifactId: 'inventory-count',
        revision: 0,
      },
      {
        type: 'artifact-read',
        participant: 'clerk-two',
        artifactId: 'inventory-count',
        revision: 1,
      },
      { type: 'artifact-read', participant: 'clerk-two', artifactId: 'scratchpad', revision: 0 },
    ];
    expect(measureTrajectory(sharedState, events).coordination.staleReads).toBe(1);
  });

  test('counts retries and replans', () => {
    const events: TrajectoryEvent[] = [
      { type: 'retry', participant: 'writer', stageId: 'draft' },
      { type: 'retry', participant: 'writer', stageId: 'draft' },
      { type: 'replan', participant: 'writer', reason: 'The draft missed the constraint twice.' },
    ];
    const { coordination } = measureTrajectory(revision, events);
    expect(coordination.retries).toBe(2);
    expect(coordination.replans).toBe(1);
  });

  test('never counts a write to an undeclared, ungoverned store as coordination or a commit', () => {
    const events: TrajectoryEvent[] = [
      ...started('clerk-one', 'clerk-two', 'keeper'),
      {
        type: 'artifact-write',
        participant: 'clerk-one',
        artifactId: 'scratchpad',
        baseRevision: 0,
        intent: 'proposal',
      },
      {
        type: 'artifact-write',
        participant: 'clerk-two',
        artifactId: 'scratchpad',
        baseRevision: 0,
        intent: 'commit',
      },
      { type: 'artifact-read', participant: 'keeper', artifactId: 'scratchpad', revision: 0 },
      ...finished('clerk-one', 'clerk-two', 'keeper'),
    ];
    const measurement = measureTrajectory(sharedState, events);
    expect(measurement.coordination.ungovernedWrites).toBe(2);
    expect(measurement.coordination.coordinationTurns).toBe(0);
    expect(measurement.coordination.coordinationTokens).toBe(0);
    expect(measurement.coordination.staleReads).toBe(0);
    expect(measurement.failures).toEqual([]);
  });

  test('counts every message and proposal a faulty participant sends before it is quarantined', () => {
    const events: TrajectoryEvent[] = [
      {
        type: 'fault',
        participant: 'clerk-one',
        kind: 'faulty-output',
        payloadDigest: 'bad-count',
      },
      message({ from: 'clerk-one', to: 'keeper', subject: 'restock', digest: 'bad-count' }),
      {
        type: 'artifact-write',
        participant: 'clerk-one',
        artifactId: 'inventory-count',
        baseRevision: 0,
        intent: 'proposal',
      },
      { type: 'quarantine', participant: 'clerk-one' },
      message({ from: 'clerk-one', to: 'keeper', subject: 'restock', digest: 'later' }),
      {
        type: 'artifact-write',
        participant: 'clerk-one',
        artifactId: 'inventory-count',
        baseRevision: 0,
        intent: 'proposal',
      },
    ];
    const measurement = measureTrajectory(sharedState, events);
    expect(measurement.coordination.propagatedFaults).toBe(2);
  });
});

describe('failure labels', () => {
  test('cover the thirteen labels the admission evidence requires', () => {
    expect(FAILURE_LABELS).toEqual([
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
    ]);
  });

  test('task or role drift: an undeclared edge, an unknown participant, a non-verifier verdict, and a non-writer proposal', () => {
    const events: TrajectoryEvent[] = [
      message({ from: 'reducer', to: 'searcher-a' }),
      message({ from: 'stranger', to: 'reducer' }),
      message({ intent: 'verification-result', from: 'searcher-b', to: 'reducer' }),
      {
        type: 'artifact-write',
        participant: 'searcher-c',
        artifactId: 'answer',
        baseRevision: 0,
        intent: 'proposal',
      },
    ];
    const measurement = measureTrajectory(partitioned, events);
    expect(measurement.failures).toEqual([
      {
        label: 'task-role-drift',
        participant: 'reducer',
        event: 0,
        evidence: 'Sent a message along the undeclared edge reducer -> searcher-a',
      },
      {
        label: 'task-role-drift',
        participant: 'stranger',
        event: 1,
        evidence: 'A message names a participant the plan does not declare: stranger -> reducer',
      },
      {
        label: 'task-role-drift',
        participant: 'searcher-b',
        event: 2,
        evidence: 'Sent a verification result without a verifier role or stage',
      },
      {
        label: 'task-role-drift',
        participant: 'searcher-c',
        event: 3,
        evidence: 'Proposed a write to "answer" without being one of its writers',
      },
    ]);
  });

  /**
   * COR-820's amendment of 2026-09-29, "what counts as a cycle": one test per
   * row of its scenario table. W is `writer`, C `counter` (verifier), E
   * `editor` (producer); F is `verifierRevisionPlanInput()` (N = 2), F1 the
   * same with N = 1, and the chord F1 plus E with edges W->E and E->C.
   */
  describe('cycle (COR-820 amendment rows)', () => {
    let sequence = 0;
    const unique = () => `event-${(sequence += 1)}`;
    const work = (from: string, to: string, subject = 'sentence', intent = 'artifact') =>
      message({ intent, from, to, subject, digest: unique() });
    const verdictOf = (
      outcome: 'accepted' | 'rejected',
      from: string,
      to: string,
      subject = 'sentence',
    ) =>
      message({
        intent: 'verification-result',
        from,
        to,
        subject,
        digest: unique(),
        verdict: outcome,
      });
    const other = (intent: string, from: string, to: string, subject = 'sentence') =>
      message({ intent, from, to, subject, digest: unique() });
    const d = (to = 'counter') => work('writer', to);
    const rej = (from = 'counter') => verdictOf('rejected', from, 'writer');
    const acc = (from = 'counter') => verdictOf('accepted', from, 'writer');
    const commit = (to = 'counter') => other('commit', 'writer', to);

    const cycleAt = (
      event: number,
      k: number,
      limit: number,
      who = 'writer',
    ): FailureOccurrence => ({
      label: 'cycle',
      participant: who,
      event,
      evidence: `Cycle ${k} exceeds the plan's limit of ${limit}`,
    });
    const driftAt = (event: number, from: string, to: string): FailureOccurrence => ({
      label: 'task-role-drift',
      participant: from,
      event,
      evidence: `Sent a message along the undeclared edge ${from} -> ${to}`,
    });
    const failures = (plan: CollaborationPlan, events: readonly TrajectoryEvent[]) =>
      measureTrajectory(plan, events).failures;
    /**
     * The events counted as revisions, whatever the plan permits: the same
     * plan with no cycles permitted labels every revision.
     */
    const revisionsIn = (plan: CollaborationPlan, events: readonly TrajectoryEvent[]) =>
      failures({ ...plan, topology: { ...plan.topology, permittedCycles: 0 } }, events)
        .filter((failure) => failure.label === 'cycle')
        .map((failure) => [failure.participant, failure.event]);

    const stage = (stageId: string, rejector: string[]) => ({
      stageId,
      boundAt: 'handoff-creation',
      acceptanceCriteria: 'The sentence has exactly seven words.',
      rejector,
      onFailure: 'retry',
      retryBudget: 2,
    });
    const verifierRevision = (options: {
      participants: ParticipantInput[];
      edges: EdgeInput[];
      permittedCycles: number;
      commitAuthority?: string;
      stageVerifiers?: PlanInput[];
    }) =>
      parseCollaborationPlan(
        planInput({
          planId: 'amendment-plan',
          taskClass: 'verifier-revision',
          executionProfile: 'collaboration',
          participants: options.participants,
          commitAuthority: options.commitAuthority ?? 'writer',
          permittedCycles: options.permittedCycles,
          edges: options.edges,
          stageVerifiers: options.stageVerifiers ?? [stage('draft', ['counter'])],
        }),
      );
    const WRITER: ParticipantInput = { agentName: 'writer', role: 'producer' };
    const COUNTER: ParticipantInput = { agentName: 'counter', role: 'verifier' };
    const EDITOR: ParticipantInput = { agentName: 'editor', role: 'producer' };
    const W_C: EdgeInput[] = [
      { from: 'writer', to: 'counter' },
      { from: 'counter', to: 'writer' },
    ];
    /** F1 plus the participants and edges named. */
    const f1Plus = (
      participants: ParticipantInput[],
      edges: EdgeInput[],
      commitAuthority?: string,
    ) =>
      verifierRevision({
        participants: [WRITER, COUNTER, ...participants],
        edges: [...W_C, ...edges],
        permittedCycles: 1,
        ...(commitAuthority === undefined ? {} : { commitAuthority }),
      });
    const F1 = f1Plus([], []);
    const chord = f1Plus(
      [EDITOR],
      [
        { from: 'writer', to: 'editor' },
        { from: 'editor', to: 'counter' },
      ],
    );

    /** Every order of `a` and `b` that keeps each one's own order. */
    function interleavings<T>(a: readonly T[], b: readonly T[]): T[][] {
      if (a.length === 0) return [[...b]];
      if (b.length === 0) return [[...a]];
      const [headA, ...restA] = a as [T, ...T[]];
      const [headB, ...restB] = b as [T, ...T[]];
      return [
        ...interleavings(restA, b).map((order) => [headA, ...order]),
        ...interleavings(a, restB).map((order) => [headB, ...order]),
      ];
    }

    test('row 1: a draft accepted and committed is no revision', () => {
      const events = [d(), acc(), commit()];
      expect(revisionsIn(revision, events)).toEqual([]);
      expect(failures(revision, events)).toEqual([]);
    });

    test('row 2: two revisions are the two cycles F permits, however the run ends', () => {
      const head = [d(), rej(), d(), rej(), d()];
      for (const events of [
        [...head, acc(), commit()],
        [...head, rej(), other('cancellation', 'counter', 'writer')],
      ]) {
        expect(revisionsIn(revision, events)).toEqual([
          ['writer', 2],
          ['writer', 4],
        ]);
        expect(failures(revision, events)).toEqual([]);
      }
    });

    test('row 3: the third revision exceeds F and is labelled at its draft', () => {
      const events = [d(), rej(), d(), rej(), d(), rej(), d()];
      expect(failures(revision, events)).toEqual([cycleAt(6, 3, 2)]);
    });

    test('row 4: a repeated rejection opens one revision, and a resent draft is not another', () => {
      const events = [d(), rej(), rej(), d(), d(), rej(), d(), acc()];
      expect(revisionsIn(revision, events)).toEqual([
        ['writer', 3],
        ['writer', 6],
      ]);
      expect(failures(revision, events)).toEqual([]);
    });

    const sequential = (edges: EdgeInput[]) =>
      parseCollaborationPlan(
        planInput({
          planId: 'sequential-plan',
          taskClass: 'sequential-dependency',
          executionProfile: 'collaboration',
          participants: [WRITER, COUNTER],
          commitAuthority: 'writer',
          permittedCycles: 0,
          edges,
        }),
      );
    const writerToCounter = sequential([{ from: 'writer', to: 'counter' }]);
    const counterToWriter = sequential([{ from: 'counter', to: 'writer' }]);

    test('row 5: revisions on undeclared edges are counted after their drift', () => {
      const events = [d(), rej(), d(), rej(), d()];
      expect(failures(writerToCounter, events)).toEqual([
        driftAt(1, 'counter', 'writer'),
        cycleAt(2, 1, 0),
        driftAt(3, 'counter', 'writer'),
        cycleAt(4, 2, 0),
      ]);
      expect(failures(counterToWriter, events)).toEqual([
        driftAt(0, 'writer', 'counter'),
        driftAt(2, 'writer', 'counter'),
        cycleAt(2, 1, 0),
        driftAt(4, 'writer', 'counter'),
        cycleAt(4, 2, 0),
      ]);
    });

    test('row 6: a rejection before any work rejects nothing and opens nothing', () => {
      const events = [rej(), d(), rej(), d(), acc()];
      expect(revisionsIn(F1, events)).toEqual([['writer', 3]]);
      expect(failures(F1, events)).toEqual([]);
      expect(failures(writerToCounter, [rej(), d()])).toEqual([driftAt(0, 'counter', 'writer')]);
    });

    test('row 7: an acceptance leaves an open revision open', () => {
      const events = [d(), rej(), acc(), d()];
      expect(revisionsIn(F1, events)).toEqual([['writer', 3]]);
      expect(failures(F1, events)).toEqual([]);
      expect(failures(F1, [...events, rej(), d()])).toEqual([cycleAt(5, 2, 1)]);
    });

    test('row 8: a rejection with no revision after it counts nothing more', () => {
      const events = [d(), rej(), d(), rej()];
      expect(revisionsIn(revision, events)).toEqual([['writer', 2]]);
      expect(failures(revision, events)).toEqual([]);
    });

    const threeParticipantLoop = verifierRevision({
      participants: [WRITER, COUNTER, EDITOR],
      edges: [
        { from: 'writer', to: 'editor' },
        { from: 'editor', to: 'counter' },
        { from: 'counter', to: 'writer' },
      ],
      permittedCycles: 1,
    });

    test('row 9: revisions relayed through an editor are not counted (known limit)', () => {
      const lap = () => [work('writer', 'editor'), work('editor', 'counter'), rej()];
      const events = Array.from({ length: 10 }, lap).flat();
      expect(revisionsIn(threeParticipantLoop, events)).toEqual([]);
      expect(failures(threeParticipantLoop, events)).toEqual([]);
      const late = [...lap(), work('writer', 'editor'), rej()];
      expect(revisionsIn(threeParticipantLoop, late)).toEqual([]);
    });

    test('row 10: work that follows no rejection is not a revision (known limit)', () => {
      const events = [d(), acc(), commit(), d(), rej(), d(), acc(), commit(), d()];
      expect(revisionsIn(revision, events)).toEqual([['writer', 5]]);
      expect(failures(revision, events)).toEqual([]);
    });

    test('row 11: requests neither open nor close a revision', () => {
      const request = () => other('request', 'counter', 'writer');
      const withRequests = [
        request(),
        d(),
        rej(),
        request(),
        d(),
        rej(),
        request(),
        d(),
        acc(),
        commit(),
        request(),
        d(),
      ];
      expect(revisionsIn(revision, withRequests)).toEqual([
        ['writer', 4],
        ['writer', 7],
      ]);
      expect(failures(revision, withRequests)).toEqual([]);
      const without = [request(), d(), rej(), d(), rej(), d(), acc(), commit(), d()];
      expect(revisionsIn(revision, without)).toEqual([
        ['writer', 3],
        ['writer', 5],
      ]);
      expect(failures(revision, without)).toEqual([]);
    });

    test('row 12: a verifier that never sends a rejected verdict drives no revisions (known limit)', () => {
      const observations = Array.from({ length: 10 }, () => [
        work('writer', 'counter', 'sentence', 'observation'),
        work('counter', 'writer', 'sentence', 'observation'),
      ]).flat();
      const rejections = Array.from({ length: 10 }, () => [
        d(),
        other('rejection', 'counter', 'writer'),
      ]).flat();
      for (const events of [observations, rejections]) {
        expect(revisionsIn(revision, events)).toEqual([]);
        expect(failures(revision, events)).toEqual([]);
      }
    });

    const twoWriters = (peer: boolean) =>
      verifierRevision({
        participants: [
          { agentName: 'writer-a', role: 'producer' },
          { agentName: 'writer-b', role: 'producer' },
          { agentName: 'verifier', role: 'verifier' },
        ],
        edges: [
          { from: 'writer-a', to: 'verifier' },
          { from: 'verifier', to: 'writer-a' },
          { from: 'writer-b', to: 'verifier' },
          { from: 'verifier', to: 'writer-b' },
          ...(peer ? [{ from: 'writer-a', to: 'writer-b' }] : []),
        ],
        permittedCycles: 1,
        commitAuthority: 'writer-a',
        stageVerifiers: [stage('draft', ['verifier'])],
      });
    const writerDraft = (writer: string, subject = 'sentence') => work(writer, 'verifier', subject);
    const writerVerdict = (
      writer: string,
      outcome: 'accepted' | 'rejected',
      subject = 'sentence',
    ) => verdictOf(outcome, 'verifier', writer, subject);
    const writerRun = (writer: string) => [
      writerDraft(writer),
      writerVerdict(writer, 'rejected'),
      writerDraft(writer),
      writerVerdict(writer, 'accepted'),
    ];
    const ordersOf = (a: readonly TrajectoryEvent[], b: readonly TrajectoryEvent[]) =>
      interleavings(a, b);

    test.each([false, true])(
      'row 13: two writers sharing one verifier revise once each in all 70 orders (peer edge: %p)',
      (peer) => {
        const plan = twoWriters(peer);
        const a = writerRun('writer-a');
        const b = writerRun('writer-b');
        const orders = ordersOf(a, b);
        expect(orders).toHaveLength(70);
        const [a1, rA1, a2] = a as [TrajectoryEvent, TrajectoryEvent, TrajectoryEvent];
        const [b1, rB1, b2] = b as [TrajectoryEvent, TrajectoryEvent, TrajectoryEvent];
        orders.push(
          [a1, rA1, a2, b1, rB1, b2],
          [a1, b1, rA1, rB1, a2, b2],
          [b1, a1, rA1, a2, rB1, b2],
        );
        for (const events of orders) {
          const counted = revisionsIn(plan, events);
          expect(counted.filter(([who]) => who === 'writer-a')).toHaveLength(1);
          expect(counted.filter(([who]) => who === 'writer-b')).toHaveLength(1);
          expect(failures(plan, events)).toEqual([]);
        }
      },
    );

    test('row 14: each writer exceeds the limit at its own third draft in all 924 orders', () => {
      const plan = twoWriters(false);
      const long = (writer: string) => [
        writerDraft(writer),
        writerVerdict(writer, 'rejected'),
        writerDraft(writer),
        writerVerdict(writer, 'rejected'),
        writerDraft(writer),
        writerVerdict(writer, 'accepted'),
      ];
      const a = long('writer-a');
      const b = long('writer-b');
      const orders = ordersOf(a, b);
      expect(orders).toHaveLength(924);
      for (const events of orders) {
        expect(failures(plan, events)).toEqual(
          [
            cycleAt(events.indexOf(a[4] as TrajectoryEvent), 2, 1, 'writer-a'),
            cycleAt(events.indexOf(b[4] as TrajectoryEvent), 2, 1, 'writer-b'),
          ].toSorted((left, right) => (left.event as number) - (right.event as number)),
        );
      }
    });

    test("row 15: the verifier's requests leave each writer's count alone in all 924 orders", () => {
      const plan = twoWriters(false);
      const requested = (writer: string) => [
        other('request', 'verifier', writer),
        writerDraft(writer),
        writerVerdict(writer, 'rejected'),
        other('request', 'verifier', writer),
        writerDraft(writer),
        writerVerdict(writer, 'accepted'),
      ];
      const orders = ordersOf(requested('writer-a'), requested('writer-b'));
      expect(orders).toHaveLength(924);
      for (const events of orders) {
        const counted = revisionsIn(plan, events);
        expect(
          counted
            .map(([who]) => who)
            .toSorted((left, right) => String(left).localeCompare(String(right))),
        ).toEqual(['writer-a', 'writer-b']);
        expect(failures(plan, events)).toEqual([]);
      }
    });

    test('row 16: each subject keeps its own count, and a first draft on a new subject is no revision', () => {
      const plan = twoWriters(false);
      const onSubject = (subject: string) => [
        writerDraft('writer-a', subject),
        writerVerdict('writer-a', 'rejected', subject),
        writerDraft('writer-a', subject),
        writerVerdict('writer-a', 'accepted', subject),
      ];
      const opening = onSubject('opening');
      const closing = onSubject('closing');
      const orders = ordersOf(opening, closing);
      expect(orders).toHaveLength(70);
      for (const events of orders) {
        expect(revisionsIn(plan, events)).toHaveLength(2);
        expect(revisionsIn(plan, events)).toEqual(
          [opening[2], closing[2]]
            .map((event) => events.indexOf(event as TrajectoryEvent))
            .toSorted((left, right) => left - right)
            .map((index) => ['writer-a', index]),
        );
        expect(failures(plan, events)).toEqual([]);
      }
      const then = [
        ...onSubject('opening'),
        writerDraft('writer-a', 'closing'),
        writerVerdict('writer-a', 'accepted', 'closing'),
      ];
      expect(revisionsIn(plan, then)).toEqual([['writer-a', 2]]);
      expect(failures(plan, then)).toEqual([]);
    });

    test('row 17a: a dense topology is measured without refusal, and no verifier means no cycle', () => {
      const plan = parseCollaborationPlan(fullyConnectedPlanInput(12));
      expect(plan.topology.edges).toHaveLength(132);
      const reviewers = Array.from({ length: 12 }, (_, index) => `reviewer-${index + 1}`);
      const laps = Array.from({ length: 5 }, () =>
        reviewers.map((from, index) =>
          work(from, reviewers[(index + 1) % reviewers.length] as string, 'review', 'observation'),
        ),
      ).flat();
      expect(labels(plan, laps)).toEqual([]);
    });

    test('row 18: revisions sent straight back on the chord are counted', () => {
      const events = [d(), rej(), d(), rej(), d(), acc()];
      expect(failures(chord, events)).toEqual([cycleAt(4, 2, 1)]);
    });

    test('row 19: a relayed revision is not counted, and the next direct one is (known limit)', () => {
      const events = [
        d(),
        rej(),
        work('writer', 'editor'),
        work('editor', 'counter'),
        rej(),
        d(),
        acc(),
      ];
      expect(revisionsIn(chord, events)).toEqual([['writer', 5]]);
      expect(failures(chord, events)).toEqual([]);
    });

    test('row 20: revisions that all go through the editor are not counted (known limit)', () => {
      const relayed = Array.from({ length: 4 }, () => [
        work('writer', 'editor'),
        work('editor', 'counter'),
        rej(),
      ]).flat();
      const events = [d(), rej(), ...relayed];
      expect(revisionsIn(chord, events)).toEqual([]);
      expect(failures(chord, events)).toEqual([]);
    });

    test('row 21: a rejection of relayed work opens nothing when the writer sent the verifier none (known limit)', () => {
      const events = [
        work('writer', 'editor'),
        work('editor', 'counter'),
        rej(),
        d(),
        rej(),
        d(),
        acc(),
      ];
      expect(revisionsIn(chord, events)).toEqual([['writer', 5]]);
      expect(failures(chord, events)).toEqual([]);
    });

    test("row 22: a rejection of relayed work is attributed to the writer's earlier direct draft (known limit)", () => {
      const relay = () => [work('writer', 'editor'), work('editor', 'counter'), rej()];
      expect(failures(chord, [d(), rej(), d(), acc(), ...relay(), d()])).toEqual([
        cycleAt(7, 2, 1),
      ]);
      expect(failures(chord, [d(), rej(), d(), ...relay(), d()])).toEqual([cycleAt(6, 2, 1)]);
    });

    test('row 23: work the verifier sends round another loop does not stop the direct count', () => {
      const plan = f1Plus(
        [EDITOR],
        [
          { from: 'counter', to: 'editor' },
          { from: 'editor', to: 'writer' },
        ],
      );
      const events = [
        d(),
        rej(),
        work('counter', 'editor'),
        work('editor', 'writer'),
        d(),
        rej(),
        d(),
      ];
      expect(failures(plan, events)).toEqual([cycleAt(6, 2, 1)]);
      const observed = () => work('counter', 'writer', 'sentence', 'observation');
      const withObservations = [
        d(),
        observed(),
        work('counter', 'editor'),
        work('editor', 'writer'),
        d(),
        observed(),
        d(),
      ];
      expect(revisionsIn(plan, withObservations)).toEqual([]);
      expect(failures(plan, withObservations)).toEqual([]);
    });

    test('row 24: work handed on to a publisher is not a revision', () => {
      const plan = f1Plus(
        [{ agentName: 'publisher', role: 'commit-authority' }],
        [{ from: 'writer', to: 'publisher' }],
        'publisher',
      );
      const events = [d(), rej(), d(), acc(), d('publisher')];
      expect(revisionsIn(plan, events)).toEqual([['writer', 2]]);
      expect(failures(plan, events)).toEqual([]);
      expect(failures(plan, [d(), rej(), d(), rej(), d(), acc(), d('publisher')])).toEqual([
        cycleAt(4, 2, 1),
      ]);
    });

    test('row 25: research exchanged with another participant is not a revision', () => {
      const plan = f1Plus(
        [{ agentName: 'researcher', role: 'producer' }],
        [
          { from: 'writer', to: 'researcher' },
          { from: 'researcher', to: 'writer' },
        ],
      );
      const research = () => [
        other('request', 'writer', 'researcher'),
        work('researcher', 'writer', 'sentence', 'observation'),
      ];
      const events = [...research(), d(), rej(), d(), acc(), commit()];
      expect(revisionsIn(plan, events)).toEqual([['writer', 4]]);
      expect(failures(plan, events)).toEqual([]);
      expect(failures(plan, [...research(), d(), rej(), d(), rej(), d(), acc(), commit()])).toEqual(
        [cycleAt(6, 2, 1)],
      );
    });

    const twoStages = verifierRevision({
      participants: [
        WRITER,
        { agentName: 'v1', role: 'verifier' },
        { agentName: 'v2', role: 'verifier' },
      ],
      edges: [
        { from: 'writer', to: 'v1' },
        { from: 'v1', to: 'writer' },
        { from: 'writer', to: 'v2' },
        { from: 'v2', to: 'writer' },
      ],
      permittedCycles: 1,
      stageVerifiers: [stage('draft', ['v1']), stage('review', ['v2'])],
    });

    test('row 26: each stage verifier keeps its own count', () => {
      const events = [d('v1'), acc('v1'), d('v2'), rej('v2'), d('v2'), acc('v2'), commit('v1')];
      expect(revisionsIn(twoStages, events)).toEqual([['writer', 4]]);
      expect(failures(twoStages, events)).toEqual([]);
      const later = [
        d('v1'),
        acc('v1'),
        d('v2'),
        rej('v2'),
        d('v2'),
        rej('v2'),
        d('v2'),
        acc('v2'),
        commit('v1'),
      ];
      expect(failures(twoStages, later)).toEqual([cycleAt(6, 2, 1)]);
    });

    test('row 27: two stage verifiers revise once each in all 20 orders', () => {
      const perVerifier = (verifier: string) => [d(verifier), rej(verifier), d(verifier)];
      const first = perVerifier('v1');
      const second = perVerifier('v2');
      const orders = ordersOf(first, second);
      expect(orders).toHaveLength(20);
      for (const events of orders) {
        expect(revisionsIn(twoStages, events)).toEqual(
          [first[2], second[2]]
            .map((event) => events.indexOf(event as TrajectoryEvent))
            .toSorted((left, right) => left - right)
            .map((index) => ['writer', index]),
        );
        expect(failures(twoStages, events)).toEqual([]);
      }
    });

    test('row 28: a revision sent to another verifier than the one that rejected is not counted (known limit)', () => {
      const events = [d('v1'), rej('v1'), d('v2'), rej('v2'), d('v1'), rej('v1'), d('v2')];
      expect(revisionsIn(twoStages, events)).toEqual([
        ['writer', 4],
        ['writer', 6],
      ]);
      expect(failures(twoStages, events)).toEqual([]);
    });
  });

  test('history loss: a later handoff drops a source the participant already had', () => {
    const events: TrajectoryEvent[] = [
      { type: 'handoff', participant: 'searcher-a', sources: ['shard-a', 'notes'] },
      { type: 'handoff', participant: 'searcher-a', sources: ['shard-a'] },
    ];
    expect(measureTrajectory(partitioned, events).failures).toEqual([
      {
        label: 'history-loss',
        participant: 'searcher-a',
        event: 1,
        evidence: 'A later handoff dropped sources it had already delivered: notes',
      },
    ]);
  });

  test('reset: a participant starts again before its earlier start finished', () => {
    const events: TrajectoryEvent[] = [
      ...started('searcher-a', 'searcher-a'),
      ...finished('searcher-a'),
      ...started('searcher-a'),
      ...finished('searcher-a'),
    ];
    expect(labels(partitioned, events)).toEqual(['reset']);
  });

  test('ignored or withheld information: a handoff without a required source', () => {
    const events: TrajectoryEvent[] = [{ type: 'handoff', participant: 'searcher-b', sources: [] }];
    expect(measureTrajectory(partitioned, events).failures).toEqual([
      {
        label: 'ignored-or-withheld-information',
        participant: 'searcher-b',
        event: 0,
        evidence: 'The handoff withheld required sources: shard-b',
      },
    ]);
    expect(labels(partitioned, [{ type: 'handoff', participant: 'reducer', sources: [] }])).toEqual(
      [],
    );
  });

  test('premature completion: a commit by anyone but the commit authority', () => {
    const events: TrajectoryEvent[] = [
      {
        type: 'artifact-write',
        participant: 'clerk-one',
        artifactId: 'inventory-count',
        baseRevision: 0,
        intent: 'commit',
      },
      message({ intent: 'commit', from: 'clerk-two', to: 'keeper', subject: 'inventory-count' }),
      message({ intent: 'commit', from: 'clerk-two', to: 'keeper', subject: 'handover-note' }),
    ];
    expect(
      measureTrajectory(sharedState, events).failures.map((failure) => failure.evidence),
    ).toEqual([
      'Committed "inventory-count", whose commit authority is keeper',
      'Committed "inventory-count", whose commit authority is keeper',
      'Committed "handover-note", whose commit authority is keeper',
    ]);
    expect(labels(sharedState, events)).toEqual([
      'premature-completion',
      'premature-completion',
      'premature-completion',
    ]);
  });

  test('missing verification: a commit no accepted verification preceded, when the plan binds stage verifiers', () => {
    const unverified = [
      message({ intent: 'commit', from: 'writer', to: 'counter', subject: 'sentence' }),
    ];
    expect(measureTrajectory(revision, unverified).failures).toEqual([
      {
        label: 'missing-or-incorrect-verification',
        participant: 'writer',
        event: 0,
        evidence: 'Committed "sentence" before any verifier accepted it',
      },
    ]);
    const verified = [
      message({
        intent: 'verification-result',
        from: 'counter',
        to: 'writer',
        subject: 'sentence',
      }),
      ...unverified,
    ];
    expect(labels(revision, verified)).toEqual([]);
    // A plan without stage verifiers does not require one before a commit.
    expect(labels(partitioned, cleanSearch())).toEqual([]);
  });

  test('missing verification also applies to an artifact commit', () => {
    const plan = parseCollaborationPlan({
      ...sharedStatePlanInput(),
      stageVerifiers: [
        {
          stageId: 'count',
          boundAt: 'handoff-creation',
          acceptanceCriteria: 'The count matches the receipts.',
          rejector: ['keeper'],
          onFailure: 'terminal',
          retryBudget: 0,
        },
      ],
    });
    const events: TrajectoryEvent[] = [
      {
        type: 'artifact-write',
        participant: 'keeper',
        artifactId: 'inventory-count',
        baseRevision: 0,
        intent: 'commit',
      },
    ];
    expect(labels(plan, events)).toEqual(['missing-or-incorrect-verification']);
  });

  test('incompatible conventions: an undeclared message schema, or one that does not cover the intent', () => {
    const events = [
      message({ schema: 'free-text' }),
      message({ intent: 'commit', from: 'reducer', to: 'searcher-a', schema: 'finding-1' }),
    ];
    expect(
      measureTrajectory(partitioned, events).failures.map((failure) => failure.evidence),
    ).toEqual([
      'Used message schema "free-text", which the plan does not declare',
      'Sent a commit message under schema "finding-1", which does not cover that intent',
      'Sent a message along the undeclared edge reducer -> searcher-a',
    ]);
  });

  test('conflicting commits: a commit against a revision another commit already moved', () => {
    const commit = (baseRevision: number): TrajectoryEvent => ({
      type: 'artifact-write',
      participant: 'keeper',
      artifactId: 'inventory-count',
      baseRevision,
      intent: 'commit',
    });
    const events = [
      commit(0),
      commit(0),
      {
        type: 'artifact-read',
        participant: 'clerk-one',
        artifactId: 'inventory-count',
        revision: 1,
      } as TrajectoryEvent,
    ];
    const measurement = measureTrajectory(sharedState, events);
    expect(measurement.failures.map((failure) => failure.label)).toEqual(['conflicting-commits']);
    // Under reject-stale the conflicting commit never applied, so revision 1 is still current.
    expect(measurement.coordination.staleReads).toBe(0);

    const merging = parseCollaborationPlan({
      ...sharedStatePlanInput(),
      artifacts: [
        {
          ...(sharedStatePlanInput()['artifacts'] as object[])[0],
          conflictBehavior: 'merge-with-verifier',
        },
      ],
    });
    const merged = measureTrajectory(merging, events);
    expect(merged.failures.map((failure) => failure.label)).toEqual(['conflicting-commits']);
    // A merge applies the second commit too, so revision 1 is now stale.
    expect(merged.coordination.staleReads).toBe(1);
  });

  test('untrusted-message elevation: a message delivered as trusted without an accepted verification', () => {
    expect(
      labels(partitioned, [message({ trust: 'trusted-authored', correlation: 'handoff-9' })]),
    ).toEqual(['untrusted-message-elevation']);
    const promoted = [
      message({
        intent: 'verification-result',
        from: 'counter',
        to: 'writer',
        correlation: 'handoff-9',
      }),
      message({
        from: 'writer',
        to: 'counter',
        trust: 'trusted-authored',
        correlation: 'handoff-9',
      }),
    ];
    expect(labels(revision, promoted)).toEqual([]);
  });

  test('prompt infection: an injected payload reappears from another participant', () => {
    const events: TrajectoryEvent[] = [
      {
        type: 'fault',
        participant: 'searcher-a',
        kind: 'prompt-injection',
        payloadDigest: 'ignore-previous',
      },
      { type: 'quarantine', participant: 'searcher-a' },
      message({ from: 'searcher-a', digest: 'ignore-previous' }),
      message({ from: 'searcher-b', digest: 'ignore-previous' }),
    ];
    expect(measureTrajectory(partitioned, events).failures).toEqual([
      {
        label: 'prompt-infection',
        participant: 'searcher-b',
        event: 3,
        evidence: 'Repeated a payload injected into searcher-a',
      },
    ]);
  });

  test('faulty-agent contamination: a commit on a subject a faulty participant touched', () => {
    const events: TrajectoryEvent[] = [
      {
        type: 'fault',
        participant: 'searcher-b',
        kind: 'faulty-output',
        payloadDigest: 'wrong-digit',
      },
      message({ from: 'searcher-b', subject: 'answer', digest: 'wrong-digit' }),
      {
        type: 'artifact-write',
        participant: 'reducer',
        artifactId: 'answer',
        baseRevision: 0,
        intent: 'commit',
      },
      message({
        intent: 'commit',
        from: 'reducer',
        to: 'searcher-a',
        subject: 'digit',
        schema: 'verdict-1',
      }),
    ];
    const measurement = measureTrajectory(partitioned, events);
    expect(
      measurement.failures.filter((failure) => failure.label === 'faulty-agent-contamination'),
    ).toEqual([
      {
        label: 'faulty-agent-contamination',
        participant: 'reducer',
        event: 2,
        evidence: 'Committed "answer", which a faulty participant had touched',
      },
    ]);
    expect(measurement.coordination.propagatedFaults).toBe(1);
  });

  test('records a failure a reviewer or verifier observed and the trajectory cannot derive', () => {
    const events: TrajectoryEvent[] = [
      {
        type: 'failure-observed',
        label: 'action-reasoning-mismatch',
        participant: 'reducer',
        evidence: 'Stated it combined three digits but used two.',
      },
    ];
    expect(measureTrajectory(partitioned, events).failures).toEqual([
      {
        label: 'action-reasoning-mismatch',
        participant: 'reducer',
        event: 0,
        evidence: 'Stated it combined three digits but used two.',
      },
    ]);
  });
});

describe('cleanup and quiescence', () => {
  test('names every participant that started and never finished as abandoned', () => {
    const events = [...started(...SEARCHERS, 'reducer'), ...finished('searcher-a', 'reducer')];
    expect(measureTrajectory(partitioned, events).cleanup).toEqual({
      state: 'abandoned',
      detached: [],
      abandoned: ['searcher-b', 'searcher-c'],
    });
  });

  test('accepts a participant deliberately detached as a named work item', () => {
    const events: TrajectoryEvent[] = [
      ...started('searcher-a', 'searcher-b'),
      { type: 'participant-finished', participant: 'searcher-a', outcome: 'cancelled' },
      {
        type: 'participant-detached',
        participant: 'searcher-b',
        workItem: 'shard-b-reindex',
        reason: 'The reindex outlives the comparison and is owned by the shard service.',
      },
    ];
    const measurement = measureTrajectory(partitioned, events);
    expect(measurement.cleanup).toEqual({
      state: 'detached',
      detached: [
        {
          participant: 'searcher-b',
          workItem: 'shard-b-reindex',
          reason: 'The reindex outlives the comparison and is owned by the shard service.',
        },
      ],
      abandoned: [],
    });
    expect(measurement.participants).toEqual({ started: 2, maximumConcurrent: 2 });
  });

  test('tracks the largest number of participants running at once', () => {
    const events = [
      ...started('searcher-a'),
      ...finished('searcher-a'),
      ...started('searcher-b', 'searcher-c'),
      ...finished('searcher-b', 'searcher-c'),
    ];
    expect(measureTrajectory(partitioned, events).participants).toEqual({
      started: 3,
      maximumConcurrent: 2,
    });
  });

  const commit: TrajectoryEvent = {
    type: 'artifact-write',
    participant: 'reducer',
    artifactId: 'answer',
    baseRevision: 0,
    intent: 'commit',
  };

  test('names participants that act without ever starting as abandoned, and counts them as running', () => {
    const events: TrajectoryEvent[] = [
      { type: 'work', participant: 'searcher-a', unit: 'shard-a' },
      message({ from: 'searcher-a', subject: 'digit-0', digest: 'digit-0' }),
      message({ from: 'searcher-b', subject: 'digit-1', digest: 'digit-1' }),
      commit,
    ];
    const measurement = measureTrajectory(partitioned, events);
    expect(measurement.cleanup).toEqual({
      state: 'abandoned',
      detached: [],
      abandoned: ['searcher-a', 'searcher-b', 'reducer'],
    });
    // Descendants and fan-out both see them, so neither envelope check can miss them.
    expect(measurement.participants).toEqual({ started: 3, maximumConcurrent: 3 });
  });

  test('names a participant that acted before its recorded start as abandoned, even once it finishes', () => {
    const events: TrajectoryEvent[] = [
      { type: 'work', participant: 'searcher-a', unit: 'shard-a' },
      // Its handoff is activity too: a participant's start precedes everything it is given.
      { type: 'handoff', participant: 'searcher-b', sources: ['shard-b'] },
      ...started('searcher-b', 'reducer'),
      commit,
      ...finished('searcher-a', 'searcher-b', 'reducer'),
    ];
    const measurement = measureTrajectory(partitioned, events);
    expect(measurement.cleanup).toEqual({
      state: 'abandoned',
      detached: [],
      abandoned: ['searcher-a', 'searcher-b'],
    });
    // The start that follows its first activity is not a second start.
    expect(measurement.failures).toEqual([]);
    expect(measurement.participants).toEqual({ started: 3, maximumConcurrent: 3 });
  });

  test('names a participant that acts after it finished or detached as abandoned, and counts it running again', () => {
    const events: TrajectoryEvent[] = [
      ...started('searcher-a', 'searcher-b'),
      ...finished('searcher-a'),
      {
        type: 'participant-detached',
        participant: 'searcher-b',
        workItem: 'shard-b-reindex',
        reason: 'The reindex outlives the comparison.',
      },
      ...started('reducer'),
      message({ from: 'searcher-a', subject: 'digit-0', digest: 'digit-0' }),
      { type: 'work', participant: 'searcher-b', unit: 'shard-b' },
      commit,
      ...finished('searcher-a', 'reducer'),
    ];
    const measurement = measureTrajectory(partitioned, events);
    expect(measurement.cleanup).toEqual({
      state: 'abandoned',
      detached: [
        {
          participant: 'searcher-b',
          workItem: 'shard-b-reindex',
          reason: 'The reindex outlives the comparison.',
        },
      ],
      abandoned: ['searcher-a', 'searcher-b'],
    });
    expect(measurement.participants).toEqual({ started: 3, maximumConcurrent: 3 });
  });

  test.each<[string, TrajectoryEvent]>([
    ['sends a message', message({ from: 'searcher-a' })],
    ['is handed its sources', { type: 'handoff', participant: 'searcher-a', sources: ['shard-a'] }],
    ['does work', { type: 'work', participant: 'searcher-a', unit: 'shard-a' }],
    [
      'reads an artifact',
      { type: 'artifact-read', participant: 'searcher-a', artifactId: 'answer', revision: 0 },
    ],
    [
      'writes an artifact',
      {
        type: 'artifact-write',
        participant: 'searcher-a',
        artifactId: 'x',
        baseRevision: 0,
        intent: 'proposal',
      },
    ],
    ['retries', { type: 'retry', participant: 'searcher-a', stageId: 'search' }],
    ['replans', { type: 'replan', participant: 'searcher-a', reason: 'The shard moved.' }],
    [
      'faults',
      { type: 'fault', participant: 'searcher-a', kind: 'faulty-output', payloadDigest: 'bad' },
    ],
  ])('a participant that %s is acting', (_, event) => {
    const measurement = measureTrajectory(partitioned, [event]);
    expect(measurement.cleanup.abandoned).toEqual(['searcher-a']);
    expect(measurement.participants).toEqual({ started: 1, maximumConcurrent: 1 });
  });

  test('a message recipient, a quarantine, and an observed failure show no one acting', () => {
    const events: TrajectoryEvent[] = [
      ...started('searcher-a'),
      message({ from: 'searcher-a', to: 'reducer' }),
      ...finished('searcher-a'),
      { type: 'quarantine', participant: 'searcher-b' },
      {
        type: 'failure-observed',
        label: 'action-reasoning-mismatch',
        participant: 'searcher-c',
        evidence: 'Claimed a digit its shard does not hold.',
      },
    ];
    const measurement = measureTrajectory(partitioned, events);
    expect(measurement.cleanup).toEqual({ state: 'quiescent', detached: [], abandoned: [] });
    expect(measurement.participants).toEqual({ started: 1, maximumConcurrent: 1 });
  });
});

describe('the trajectory schema', () => {
  test('requires a verdict on a verification result and forbids one anywhere else', () => {
    const verification = message({ intent: 'verification-result' }) as Record<string, unknown>;
    delete verification['verdict'];
    const observation = { ...(message() as object), verdict: 'accepted' };
    const parsed = collaborationTrajectorySchema.safeParse([verification, observation]);
    expect(parsed.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['0.verdict', 'A verification result carries an accepted or rejected verdict'],
      ['1.verdict', 'Only a verification result carries a verdict'],
    ]);
  });

  test('parseCollaborationTrajectory returns the events or throws a typed configuration error', () => {
    expect(parseCollaborationTrajectory(cleanSearch())).toEqual(cleanSearch());
    expect(() => parseCollaborationTrajectory([{ type: 'gossip' }])).toThrow(/type/);
  });
});
