/**
 * A bureau's events, as a replay-plus-live feed.
 *
 * The same boundary `@lostgradient/operative`'s `run-event-feed.ts` draws, for the
 * same reasons, on the same Weft primitive — so a client watching a bureau
 * gets the cursors, replay, and resume semantics it already gets watching a
 * run or a workflow.
 *
 * ONE FEED PER BUREAU, not per run. Bureau's events are instance-scoped:
 * registration, recovery, disposal, and review lifecycle describe the
 * supervisor rather than any single run, so the feed is shaped like Weft's
 * fleet feed rather than its per-workflow one. A subscriber narrows with the
 * operation's `kinds` filter.
 *
 * @module bureau-event-feed
 */

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  bindFeedLifetime,
  createInMemoryReplayLiveBackend,
  createReplayLiveFeed,
  encodeCursor,
  type InMemoryReplayLiveBackend,
  type ReplayLiveFeed,
  type SequencedEventEnvelope,
} from '@lostgradient/weft';

import { FRAMES_DROPPED_KIND, withFramesDroppedMarker } from './frames-dropped.ts';
import {
  ActionEvent,
  BureauDisposedEvent,
  RunAbortSettledEvent,
  RecoveryAttemptedEvent,
  RecoveryLeaseReleasedEvent,
  RecoveryRejectedEvent,
  ReviewApprovedEvent,
  ReviewRequestedEvent,
  ReviewCanceledEvent,
  ReviewDeniedEvent,
  ReviewExpiredEvent,
  ReviewRejectedEvent,
  ReviewRevokedEvent,
  ReviewSupersededEvent,
  RunRegisteredEvent,
  RunSettledEvent,
  RunRemovedEvent,
} from './events.ts';
import {
  AgentScheduledEvent,
  ScheduleAttemptedEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  ScheduleSkippedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionSavedEvent,
  SteeringAcceptedEvent,
} from '@lostgradient/operative';
import {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills/events.ts';
import type { BureauEventMap } from './events.ts';

export type BureauEventEnvelope = SequencedEventEnvelope & {
  readonly bureauId: string;
  readonly kind: string;
  readonly emittedAtMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

type BureauEventProjection = {
  readonly kind: string;
  readonly tryProject: (event: unknown) => Readonly<Record<string, unknown>> | undefined;
};

function projection<TEvent>(
  kind: string,
  matches: (event: unknown) => event is TEvent,
  project: (event: TEvent) => Readonly<Record<string, unknown>>,
): BureauEventProjection {
  return { kind, tryProject: (event) => (matches(event) ? project(event) : undefined) };
}

const isInstance =
  <TEvent>(constructor: abstract new (...args: never[]) => TEvent) =>
  (event: unknown): event is TEvent =>
    event instanceof constructor;

/**
 * A settled review, projected identically whichever verb settled it.
 *
 * `reviewKind` rather than `kind`, deliberately. The review classes carry
 * their own `kind` field (which sort of review it was), and the envelope
 * already uses `kind` for the event type. Two different meanings under one
 * name in nested objects is a reliable way to read the wrong one.
 */
function projectReview(event: {
  reviewId: string;
  runId: string;
  principal: string;
  kind: string;
}): Readonly<Record<string, unknown>> {
  return {
    reviewId: event.reviewId,
    runId: event.runId,
    principal: event.principal,
    reviewKind: event.kind,
  };
}

export type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** Classifies every declared Bureau event as publishable or explicitly denied. */
export const BUREAU_EVENT_CLASSIFICATION = {
  action: 'published',
  'run.registered': 'published',
  'run.settled': 'published',
  'run.removed': 'published',
  'run.abort-settled': 'published',
  'bureau.disposed': 'published',
  'recovery.attempted': 'published',
  'recovery.rejected': 'published',
  'recovery.lease-released': 'published',
  'schedule.created': 'published',
  'schedule.paused': 'published',
  'schedule.resumed': 'published',
  'schedule.cancelled': 'published',
  'schedule.failed': 'published',
  'schedule.completed': 'published',
  'schedule.attempted': 'published',
  'schedule.skipped': 'published',
  'skill.loaded': 'published',
  'skill.activated': 'published',
  'skill.deactivated': 'published',
  'skill.rejected': 'published',
  'skill.failed': 'published',
  'session.created': 'published',
  'session.saved': 'published',
  'session.deleted': 'published',
  'review.requested': 'published',
  'review.approved': 'published',
  'review.denied': 'published',
  'review.rejected': 'published',
  'review.expired': 'published',
  'review.revoked': 'published',
  'review.canceled': 'published',
  'review.superseded': 'published',
  'steering.accepted': 'published',
} as const satisfies Record<DeclaredKeys<BureauEventMap>, 'published' | { denied: string }>;

export type PublishedBureauEventKind = {
  [K in DeclaredKeys<BureauEventMap>]: (typeof BUREAU_EVENT_CLASSIFICATION)[K] extends 'published'
    ? K
    : never;
}[DeclaredKeys<BureauEventMap>];

const PROJECTIONS: readonly BureauEventProjection[] = [
  projection(ActionEvent.type, isInstance(ActionEvent), (event) => ({
    // `detail` is `unknown` and caller-supplied, so the log's shape crosses
    // but its contents do not.
    sequence: event.action.sequence,
    runId: event.action.runId,
    actionType: event.action.type,
    timestamp: event.action.timestamp,
  })),
  projection(RunRegisteredEvent.type, isInstance(RunRegisteredEvent), (event) => ({
    runId: event.runId,
  })),
  projection(RunSettledEvent.type, isInstance(RunSettledEvent), (event) => ({
    runId: event.runId,
  })),
  projection(RunRemovedEvent.type, isInstance(RunRemovedEvent), (event) => ({
    runId: event.runId,
  })),
  projection(BureauDisposedEvent.type, isInstance(BureauDisposedEvent), () => ({})),
  projection(RecoveryAttemptedEvent.type, isInstance(RecoveryAttemptedEvent), (event) => ({
    runId: event.runId,
    verdict: event.verdict,
  })),
  projection(RecoveryRejectedEvent.type, isInstance(RecoveryRejectedEvent), (event) => ({
    runId: event.runId,
    reason: event.reason,
  })),
  projection(RecoveryLeaseReleasedEvent.type, isInstance(RecoveryLeaseReleasedEvent), (event) => ({
    // The lease evidence itself is Weft's projection of engine health and is
    // not reshaped here; a subscriber that needs it reads the run.
    runId: event.runId,
  })),
  projection(RunAbortSettledEvent.type, isInstance(RunAbortSettledEvent), (event) => ({
    runId: event.runId,
  })),
  projection(AgentScheduledEvent.type, isInstance(AgentScheduledEvent), (event) => ({
    agentName: event.agentName,
    scheduleId: event.scheduleId,
    sessionId: event.sessionId,
  })),
  projection(SchedulePausedEvent.type, isInstance(SchedulePausedEvent), (event) => ({
    scheduleId: event.scheduleId,
    dedupeKey: event.dedupeKey,
    committedAtMs: event.committedAtMs,
  })),
  projection(ScheduleResumedEvent.type, isInstance(ScheduleResumedEvent), (event) => ({
    scheduleId: event.scheduleId,
    dedupeKey: event.dedupeKey,
    committedAtMs: event.committedAtMs,
  })),
  projection(ScheduleCancelledEvent.type, isInstance(ScheduleCancelledEvent), (event) => ({
    scheduleId: event.scheduleId,
    dedupeKey: event.dedupeKey,
    committedAtMs: event.committedAtMs,
  })),
  projection(ScheduleFailedEvent.type, isInstance(ScheduleFailedEvent), (event) => ({
    scheduleId: event.scheduleId,
    runId: event.runId,
    status: 'failed',
  })),
  projection(ScheduleCompletedEvent.type, isInstance(ScheduleCompletedEvent), (event) => ({
    scheduleId: event.scheduleId,
    runId: event.runId,
    status: 'completed',
  })),
  projection(ScheduleAttemptedEvent.type, isInstance(ScheduleAttemptedEvent), (event) => ({
    scheduleId: event.scheduleId,
    occurrence: event.occurrence,
  })),
  projection(ScheduleSkippedEvent.type, isInstance(ScheduleSkippedEvent), (event) => ({
    scheduleId: event.scheduleId,
    occurrence: event.occurrence,
    blockingRunId: event.blockingRunId,
    policy: event.policy,
  })),
  projection(SkillLoadedEvent.type, isInstance(SkillLoadedEvent), (event) => ({
    skillName: event.skillName,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'loaded',
  })),
  projection(SkillActivatedEvent.type, isInstance(SkillActivatedEvent), (event) => ({
    skillName: event.skillName,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'activated',
  })),
  projection(SkillDeactivatedEvent.type, isInstance(SkillDeactivatedEvent), (event) => ({
    skillName: event.skillName,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'deactivated',
  })),
  projection(SkillRejectedEvent.type, isInstance(SkillRejectedEvent), (event) => ({
    skillName: event.skillName,
    reason: event.reason,
    rule: event.rule,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'rejected',
  })),
  projection(SkillFailedEvent.type, isInstance(SkillFailedEvent), (event) => ({
    skillName: event.skillName,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'failed',
  })),
  projection(SessionCreatedEvent.type, isInstance(SessionCreatedEvent), (event) => ({
    sessionId: event.sessionId,
    agentName: event.agentName,
    incarnation: event.incarnation,
    ordinal: event.ordinal,
    committedAtMs: event.committedAtMs,
  })),
  projection(SessionSavedEvent.type, isInstance(SessionSavedEvent), (event) => ({
    sessionId: event.sessionId,
    agentName: event.agentName,
    incarnation: event.incarnation,
    ordinal: event.ordinal,
    committedAtMs: event.committedAtMs,
  })),
  projection(SessionDeletedEvent.type, isInstance(SessionDeletedEvent), (event) => ({
    sessionId: event.sessionId,
    incarnation: event.incarnation,
    ordinal: event.ordinal,
    committedAtMs: event.committedAtMs,
  })),
  projection(SteeringAcceptedEvent.type, isInstance(SteeringAcceptedEvent), (event) => ({
    sessionId: event.sessionId,
    commandId: event.commandId,
    configVersion: event.configVersion,
    status: 'accepted',
  })),
  projection(ReviewRequestedEvent.type, isInstance(ReviewRequestedEvent), projectReview),
  projection(ReviewApprovedEvent.type, isInstance(ReviewApprovedEvent), projectReview),
  projection(ReviewDeniedEvent.type, isInstance(ReviewDeniedEvent), projectReview),
  projection(ReviewRejectedEvent.type, isInstance(ReviewRejectedEvent), projectReview),
  projection(ReviewExpiredEvent.type, isInstance(ReviewExpiredEvent), projectReview),
  projection(ReviewRevokedEvent.type, isInstance(ReviewRevokedEvent), projectReview),
  projection(ReviewCanceledEvent.type, isInstance(ReviewCanceledEvent), projectReview),
  projection(ReviewSupersededEvent.type, isInstance(ReviewSupersededEvent), projectReview),
];

/** Every event kind this feed publishes, derived from the exhaustive classification. */
export const PUBLISHED_BUREAU_EVENT_KINDS = Object.entries(BUREAU_EVENT_CLASSIFICATION)
  .filter(([, classification]) => classification === 'published')
  .map(([kind]) => kind) as unknown as readonly [
  PublishedBureauEventKind,
  ...PublishedBureauEventKind[],
];

/** Every event kind this feed knows how to publish, as declared by the registry. */
export const publishedBureauEventKinds: readonly string[] = PROJECTIONS.map((entry) => entry.kind);

/** Projects one dispatched event, or `undefined` when it has no projection. */
export function projectBureauEvent(
  event: unknown,
): { kind: string; payload: Readonly<Record<string, unknown>> } | undefined {
  for (const entry of PROJECTIONS) {
    const payload = entry.tryProject(event);
    if (payload !== undefined) return { kind: entry.kind, payload };
  }
  return undefined;
}

export type BureauEventFeed = {
  readonly feed: ReplayLiveFeed<BureauEventEnvelope>;
  /**
   * Aborts when the feed is disposed, so a live subscription ends instead of
   * going quiet — disposing a feed otherwise unhooks its subscribers without
   * waking them. Every subscription `feed` hands out is already bound to
   * this signal by Weft's `bindFeedLifetime`; a caller needs it only to ask
   * whether the feed is still live.
   */
  readonly signal: AbortSignal;
  publish(event: unknown): BureauEventEnvelope | undefined;
  dispose(): void;
};

export type BureauEventFeedOptions = {
  bureauId: string;
  maxEvents?: number;
  /**
   * How many live envelopes one subscriber may fall behind before its buffer
   * overflows. Defaults to Weft's. An overflow yields one
   * {@link FRAMES_DROPPED_KIND} marker and the stream continues (COR-1477).
   */
  liveBufferSize?: number;
  now?: () => number;
};

export function createBureauEventFeed(options: BureauEventFeedOptions): BureauEventFeed {
  // `NaN` or `Infinity` would make the overflow check (`length >= size`) never
  // fire, and the live buffer of a slow subscriber would grow without bound.
  const liveBufferSize = options.liveBufferSize;
  if (
    liveBufferSize !== undefined &&
    !(Number.isSafeInteger(liveBufferSize) && liveBufferSize >= 0)
  ) {
    throw new RangeError(
      `Bureau event feed liveBufferSize must be a non-negative integer, got ${liveBufferSize}.`,
    );
  }
  const now = options.now ?? createDefaultRuntimeServices().clock.now;
  const backend: InMemoryReplayLiveBackend<BureauEventEnvelope> =
    createInMemoryReplayLiveBackend<BureauEventEnvelope>(
      options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents },
    );
  const lifetime = new AbortController();
  const feed = withFramesDroppedMarker(
    bindFeedLifetime(
      createReplayLiveFeed<BureauEventEnvelope>(
        backend,
        options.liveBufferSize === undefined ? {} : { liveBufferSize: options.liveBufferSize },
      ),
      lifetime.signal,
    ),
    lifetime.signal,
    // Positioned at the last event the reader received, so resuming from the
    // marker's cursor skips nothing. It names no projection, so it is not in
    // `PUBLISHED_BUREAU_EVENT_KINDS` and a `kinds` filter never hides it.
    ({ sequence: lastSequence, cursor }) => ({
      sequence: lastSequence,
      cursor,
      bureauId: options.bureauId,
      kind: FRAMES_DROPPED_KIND,
      emittedAtMs: now(),
      payload: {},
    }),
  );
  let sequence = 0;

  return {
    feed,
    signal: lifetime.signal,
    publish(event) {
      const projected = projectBureauEvent(event);
      if (projected === undefined) return undefined;
      const envelope: BureauEventEnvelope = {
        sequence,
        cursor: encodeCursor(sequence),
        bureauId: options.bureauId,
        kind: projected.kind,
        emittedAtMs: now(),
        payload: projected.payload,
      };
      sequence += 1;
      backend.append(envelope);
      return envelope;
    },
    dispose() {
      // Before the backend, so a subscriber observes the abort rather than a
      // silently emptied log.
      lifetime.abort();
      feed.dispose();
      backend.dispose();
    },
  };
}
